const _ = require("lodash");
const Checker = require("../../common/checker");
const LangGraphADGOutputStrategy = require("./langgraph-adg-output-strategy");
const constValue = require("../../../util/constant");
const astUtil = require("../../../util/ast-util");
const logger = require("../../../util/logger")(__filename);
const config = require("../../../config");
const EntryPoint = require("../../../engine/analyzer/common/entrypoint");
const { extractRelativePath } = require("../../../util/file-util");

/**
 * LangGraphADGChecker analyzes LangGraph applications and builds Agent Dependency Graphs (ADG)
 *
 * This checker tracks:
 * - StateGraph instances and their construction
 * - add_node calls to identify agent nodes
 * - add_edge calls to identify static control flow edges
 * - add_conditional_edges calls to identify conditional routing
 * - Command return values in node functions for dynamic routing
 * - Agent configurations (LLM models, tools, system prompts)
 */
class LangGraphADGChecker extends Checker {
  /**
   * @param {ResultManager} resultManager
   */
  constructor(resultManager) {
    super(resultManager, "langgraph_adg");

    // Track StateGraph instances: { graphVarName: { graphSymbol, nodes, edges, config } }
    this.graphs = new Map();

    // Track agent definitions: { nodeName: { llm, tools, systemPrompt, nodeFunction } }
    this.agents = new Map();

    // Track tools discovered in the code
    this.tools = new Map();

    // Track LLM instances
    this.llms = new Map();

    // Track create_react_agent calls
    this.reactAgents = new Map();

    // Entry points for analysis
    this.entryPoints = [];
  }

  /**
   * Trigger at start of analysis to initialize tracking
   */
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    logger.info("[LangGraph ADG] Starting analysis...");
    this.analyzer = analyzer;
    this.moduleManager = analyzer.moduleManager;

    // Prepare entry points for analysis
    this.prepareEntryPoints(analyzer);

    // Add entry points to analyzer
    if (this.entryPoints) {
      analyzer.entryPoints.push(...this.entryPoints);
      logger.info(
        `[LangGraph ADG] Added ${this.entryPoints.length} entry point(s)`
      );
    } else {
      logger.warn(
        "[LangGraph ADG] No entry points found, analysis may not work properly"
      );
    }
  }

  /**
   * Prepare entry points by scanning all Python files in the directory
   */
  prepareEntryPoints(analyzer) {
    const fullCallGraphFileEntryPoint = require("../../common/full-callgraph-file-entrypoint");
    if (config.entryPointMode !== "ONLY_CUSTOM") {
      // 使用callgraph边界作为entrypoint
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer);
      const fullCallGraphEntrypoint =
        fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
          analyzer.ainfo?.callgraph
        );
      // 使用file作为entrypoint
      const fullFileEntrypoint =
        fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(
          analyzer.fileManager
        );
      this.entryPoints.push(...fullFileEntrypoint);
      this.entryPoints.push(...fullCallGraphEntrypoint);
    }
  }

  /**
   * Trigger at assignment to detect StateGraph instantiation and variable assignments
   */
  triggerAtAssignment(analyzer, scope, node, state, info) {
    if (!node || node.type !== "Assignment") return;

    logger.debug(
      `[LangGraph ADG] triggerAtAssignment: ${node.type}, line ${node.loc?.start?.line}`
    );

    const leftVal = state.varval[node.left];
    const rightVal = state.varval[node.right];

    logger.debug(
      `[LangGraph ADG] Assignment - left: ${this.getVariableName(node.left)}, right type: ${rightVal?.vtype}, constructor: ${rightVal?.constructor?.name}`
    );

    // Detect: workflow = StateGraph(MessagesState)
    if (this.isStateGraphInstance(rightVal)) {
      const varName = this.getVariableName(node.left);
      if (varName) {
        logger.info(`[LangGraph ADG] Found StateGraph instance: ${varName}`);
        this.graphs.set(varName, {
          graphSymbol: rightVal,
          graphVarName: varName,
          nodes: new Map(),
          edges: [],
          conditionalEdges: [],
          commandEdges: [],
          entryPoint: null,
          astNode: node,
        });
      }
    }

    // Detect: llm = ChatAnthropic(model="claude-3-5-sonnet-latest")
    if (this.isLLMInstance(rightVal)) {
      const varName = this.getVariableName(node.left);
      if (varName) {
        const modelName = this.extractLLMModelName(node.right, state);
        logger.info(
          `[LangGraph ADG] Found LLM instance: ${varName}, model: ${modelName}`
        );
        this.llms.set(varName, {
          llmSymbol: rightVal,
          varName: varName,
          modelName: modelName || "unknown",
          astNode: node.right,
        });
      }
    }

    // Detect: research_agent = create_react_agent(llm, tools=[...], prompt="...")
    if (this.isCreateReactAgentCall(rightVal)) {
      const varName = this.getVariableName(node.left);
      if (varName) {
        const agentInfo = this.extractReactAgentInfo(node.right, state);
        logger.info(`[LangGraph ADG] Found create_react_agent: ${varName}`);
        this.reactAgents.set(varName, agentInfo);
      }
    }
  }

  /**
   * Trigger before function calls to detect add_node, add_edge, etc.
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    if (!node || node.type !== "FunctionCall") return;

    const { fclos, argvalues } = info;
    if (!fclos) return;

    const funcName = this.getFunctionName(fclos, node);

    // Detect: workflow.add_node("researcher", research_node)
    if (funcName === "add_node") {
      this.handleAddNode(node, state, argvalues, info);
    }

    // Detect: workflow.add_edge(START, "researcher")
    else if (funcName === "add_edge") {
      this.handleAddEdge(node, state, argvalues);
    }

    // Detect: workflow.add_conditional_edges(...)
    else if (funcName === "add_conditional_edges") {
      this.handleAddConditionalEdges(node, state, argvalues);
    }

    // Detect: workflow.set_entry_point("researcher") or graph.add_edge(START, ...)
    else if (funcName === "set_entry_point") {
      this.handleSetEntryPoint(node, state, argvalues);
    }
  }

  /**
   * Trigger at function definition to analyze node functions for Command returns
   */
  triggerAtFunctionDefinition(analyzer, scope, node, state, info) {
    if (!node || node.type !== "FunctionDefinition") return;

    const funcName = node.name?.name || node.id?.name;
    if (!funcName) return;

    // Analyze function body for Command return statements
    const commandInfo = this.analyzeCommandReturns(node, state);
    if (commandInfo && commandInfo.hasCommand) {
      logger.info(
        `[LangGraph ADG] Function ${funcName} returns Command with goto: ${JSON.stringify(commandInfo.gotoTargets)}`
      );

      // Store command info for later edge creation
      if (!this.commandReturns) {
        this.commandReturns = new Map();
      }
      this.commandReturns.set(funcName, commandInfo);
    }
  }

  /**
   * Trigger at end of analysis to build final ADG and output results
   */
  triggerAtEndOfAnalyze(analyzer, scope, node, state, info) {
    logger.info("[LangGraph ADG] Building final Agent Dependency Graph...");

    const adgs = [];

    for (const [graphName, graphData] of this.graphs) {
      const adg = this.buildADG(graphName, graphData);
      adgs.push(adg);
    }

    if (adgs.length > 0) {
      const finding = {
        type: this.getCheckerId(),
        graphs: adgs,
        agents: Array.from(this.agents.values()),
        tools: Array.from(this.tools.values()),
        llms: Array.from(this.llms.values()),
      };

      this.resultManager.newFinding(
        finding,
        LangGraphADGOutputStrategy.outputStrategyId
      );
      logger.info(`[LangGraph ADG] Generated ${adgs.length} ADG(s)`);
    } else {
      logger.warn("[LangGraph ADG] No LangGraph graphs found in the codebase");
    }
  }

  // ==================== Helper Methods ====================

  /**
   * Check if a symbol value is a StateGraph instance
   */
  isStateGraphInstance(symVal) {
    if (!symVal) return false;

    // Check if it's a function call result
    if (symVal.vtype === "object" || symVal.vtype === "class") {
      const typeName = this.getTypeName(symVal);
      return typeName && typeName.includes("StateGraph");
    }

    return false;
  }

  /**
   * Check if a symbol value is an LLM instance (ChatAnthropic, etc.)
   */
  isLLMInstance(symVal) {
    if (!symVal) return false;

    if (symVal.vtype === "object" || symVal.vtype === "class") {
      const typeName = this.getTypeName(symVal);
      return (
        typeName &&
        (typeName.includes("ChatAnthropic") ||
          typeName.includes("ChatOpenAI") ||
          typeName.includes("Chat") ||
          typeName.toLowerCase().includes("llm"))
      );
    }

    return false;
  }

  /**
   * Check if a call is create_react_agent
   */
  isCreateReactAgentCall(symVal) {
    // This checks the result of the call, we need to check during function call
    return false;
  }

  /**
   * Get variable name from assignment left side
   */
  getVariableName(leftNode) {
    if (!leftNode) return null;

    if (leftNode.type === "Identifier") {
      return leftNode.name;
    }

    return null;
  }

  /**
   * Get function name from function closure or AST node
   */
  getFunctionName(fclos, node) {
    // Try to get from function closure
    if (fclos && fclos.name) {
      return fclos.name;
    }

    // Try to get from AST node (MemberAccess: obj.method())
    if (node.callee && node.callee.type === "MemberAccess") {
      const property = node.callee.property;
      if (property && property.name) {
        return property.name;
      }
    }

    return null;
  }

  /**
   * Get type name from symbol value
   */
  getTypeName(symVal) {
    if (!symVal) return null;

    // Check constructor or type info
    if (symVal.constructor && symVal.constructor.name) {
      return symVal.constructor.name;
    }

    if (
      symVal.__proto__ &&
      symVal.__proto__.constructor &&
      symVal.__proto__.constructor.name
    ) {
      return symVal.__proto__.constructor.name;
    }

    // Check if there's a type field
    if (symVal.type) {
      return symVal.type;
    }

    return null;
  }

  /**
   * Handle add_node call
   * Supports: add_node(name, function) or add_node(function)
   */
  handleAddNode(node, state, argvalues, info) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) {
      logger.debug(
        "[LangGraph ADG] add_node called but graph instance not found"
      );
      return;
    }

    let nodeName, nodeFunction;

    if (argvalues && argvalues.length >= 2) {
      // Form: add_node("researcher", research_node)
      const nameArg = argvalues[0];
      const funcArg = argvalues[1];

      nodeName = this.extractStringValue(nameArg);
      nodeFunction = funcArg;
    } else if (argvalues && argvalues.length === 1) {
      // Form: add_node(research_node) - name inferred from function
      nodeFunction = argvalues[0];
      nodeName = this.inferNodeName(nodeFunction);
    }

    if (!nodeName) {
      logger.warn(
        "[LangGraph ADG] Could not extract node name from add_node call"
      );
      return;
    }

    logger.info(`[LangGraph ADG] Adding node: ${nodeName}`);

    const nodeInfo = {
      name: nodeName,
      nodeFunction: nodeFunction,
      functionName: this.getFunctionNameFromValue(nodeFunction),
      astNode: node,
      isAgent: false,
      agentInfo: null,
    };

    // Check if this node is associated with a create_react_agent
    const agentInfo = this.findAgentInfoForNode(nodeFunction, state);
    if (agentInfo) {
      nodeInfo.isAgent = true;
      nodeInfo.agentInfo = agentInfo;
      this.agents.set(nodeName, {
        name: nodeName,
        ...agentInfo,
      });
    }

    graphInstance.nodes.set(nodeName, nodeInfo);

    // Check if this node function returns Command - create command edges
    const funcName = nodeInfo.functionName;
    if (funcName && this.commandReturns && this.commandReturns.has(funcName)) {
      const commandInfo = this.commandReturns.get(funcName);
      for (const target of commandInfo.gotoTargets) {
        graphInstance.commandEdges.push({
          from: nodeName,
          to: target,
          gotoTargets: commandInfo.gotoTargets,
          hasStateUpdate: commandInfo.hasStateUpdate,
          targetGraph: commandInfo.targetGraph,
          isDynamic: true,
        });
      }
    }
  }

  /**
   * Handle add_edge call
   * Form: add_edge(start, end) or add_edge(START, "node")
   */
  handleAddEdge(node, state, argvalues) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) return;

    if (!argvalues || argvalues.length < 2) {
      logger.warn("[LangGraph ADG] add_edge requires 2 arguments");
      return;
    }

    const startNode = this.extractNodeName(argvalues[0]);
    const endNode = this.extractNodeName(argvalues[1]);

    if (!startNode || !endNode) {
      logger.warn(
        `[LangGraph ADG] Could not extract edge endpoints: ${startNode} -> ${endNode}`
      );
      return;
    }

    logger.info(`[LangGraph ADG] Adding edge: ${startNode} -> ${endNode}`);

    graphInstance.edges.push({
      from: startNode,
      to: endNode,
      astNode: node,
    });

    // Track entry point if START -> node
    if (startNode === "START" || startNode === "__start__") {
      graphInstance.entryPoint = endNode;
    }
  }

  /**
   * Handle add_conditional_edges call
   * Forms:
   * - add_conditional_edges(source, path_function)
   * - add_conditional_edges(source, path_function, path_map)
   */
  handleAddConditionalEdges(node, state, argvalues) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) return;

    if (!argvalues || argvalues.length < 2) {
      logger.warn(
        "[LangGraph ADG] add_conditional_edges requires at least 2 arguments"
      );
      return;
    }

    const sourceNode = this.extractNodeName(argvalues[0]);
    const pathFunction = argvalues[1];
    const pathMap = argvalues.length >= 3 ? argvalues[2] : null;

    if (!sourceNode) {
      logger.warn(
        "[LangGraph ADG] Could not extract source node for conditional edges"
      );
      return;
    }

    // Extract possible destinations
    let destinations = [];

    if (pathMap) {
      // Extract from path_map (dict or list)
      destinations = this.extractDestinationsFromPathMap(pathMap, state);
    } else if (pathFunction) {
      // Analyze path function for return values
      destinations = this.analyzePathFunction(pathFunction, state);
    }

    logger.info(
      `[LangGraph ADG] Adding conditional edges from ${sourceNode} to ${JSON.stringify(destinations)}`
    );

    for (const dest of destinations) {
      graphInstance.conditionalEdges.push({
        from: sourceNode,
        to: dest,
        isConditional: true,
        condition: "runtime-decision",
        astNode: node,
      });
    }
  }

  /**
   * Handle set_entry_point call
   */
  handleSetEntryPoint(node, state, argvalues) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) return;

    if (!argvalues || argvalues.length < 1) return;

    const entryNode = this.extractNodeName(argvalues[0]);
    if (entryNode) {
      logger.info(`[LangGraph ADG] Setting entry point: ${entryNode}`);
      graphInstance.entryPoint = entryNode;

      // Also add START -> entry edge
      graphInstance.edges.push({
        from: "START",
        to: entryNode,
        astNode: node,
      });
    }
  }

  /**
   * Find the graph instance that the current method call belongs to
   */
  findGraphInstance(node, state) {
    // Try to find which graph this method is called on
    // Look for: workflow.add_node(...) where workflow is a StateGraph

    if (node.callee && node.callee.type === "MemberAccess") {
      const objectNode = node.callee.object;
      if (objectNode && objectNode.type === "Identifier") {
        const varName = objectNode.name;
        if (this.graphs.has(varName)) {
          return this.graphs.get(varName);
        }
      }
    }

    // Fallback: return the first (or only) graph
    if (this.graphs.size === 1) {
      return Array.from(this.graphs.values())[0];
    }

    return null;
  }

  /**
   * Extract string value from symbol value
   */
  extractStringValue(symVal) {
    if (!symVal) return null;

    if (typeof symVal === "string") {
      return symVal;
    }

    if (symVal.vtype === "const" && typeof symVal.value === "string") {
      return symVal.value;
    }

    return null;
  }

  /**
   * Extract node name (handles START, END, string literals, Identifier)
   */
  extractNodeName(symVal) {
    if (!symVal) return null;

    // String literal
    const strVal = this.extractStringValue(symVal);
    if (strVal) return strVal;

    // Identifier (START, END constants)
    if (symVal.name) {
      return symVal.name;
    }

    return null;
  }

  /**
   * Infer node name from function symbol
   */
  inferNodeName(funcSymbol) {
    if (!funcSymbol) return null;

    if (funcSymbol.name) {
      return funcSymbol.name;
    }

    if (funcSymbol.id && funcSymbol.id.name) {
      return funcSymbol.id.name;
    }

    return "anonymous_node";
  }

  /**
   * Get function name from a symbol value
   */
  getFunctionNameFromValue(funcSymbol) {
    if (!funcSymbol) return null;

    if (funcSymbol.name) {
      return funcSymbol.name;
    }

    if (funcSymbol.fdef && funcSymbol.fdef.name) {
      return funcSymbol.fdef.name;
    }

    return null;
  }

  /**
   * Analyze function for Command return statements
   */
  analyzeCommandReturns(funcDefNode, state) {
    if (!funcDefNode || !funcDefNode.body) return null;

    const commandInfo = {
      hasCommand: false,
      gotoTargets: [],
      hasStateUpdate: false,
      hasResume: false,
      targetGraph: null,
    };

    // Traverse function body looking for return Command(...)
    this.traverseForCommandReturns(funcDefNode.body, commandInfo, state);

    return commandInfo.hasCommand ? commandInfo : null;
  }

  /**
   * Recursively traverse AST looking for Command returns
   */
  traverseForCommandReturns(node, commandInfo, state) {
    if (!node) return;

    if (node.type === "ReturnStatement" && node.value) {
      // Check if return value is a Command(...) call
      if (node.value.type === "FunctionCall") {
        const callee = node.value.callee;
        if (
          callee &&
          callee.type === "Identifier" &&
          callee.name === "Command"
        ) {
          commandInfo.hasCommand = true;

          // Extract goto argument
          const args = node.value.args;
          if (args) {
            for (const arg of args) {
              if (arg.type === "KeywordArgument") {
                if (arg.arg === "goto") {
                  const gotoTargets = this.extractGotoTargets(arg.value, state);
                  commandInfo.gotoTargets.push(...gotoTargets);
                } else if (arg.arg === "update") {
                  commandInfo.hasStateUpdate = true;
                } else if (arg.arg === "resume") {
                  commandInfo.hasResume = true;
                } else if (arg.arg === "graph") {
                  commandInfo.targetGraph = this.extractStringValue(arg.value);
                }
              }
            }
          }
        }
      }
    }

    // Recursively traverse child nodes
    if (node.body) {
      if (Array.isArray(node.body)) {
        for (const child of node.body) {
          this.traverseForCommandReturns(child, commandInfo, state);
        }
      } else {
        this.traverseForCommandReturns(node.body, commandInfo, state);
      }
    }

    if (node.statements) {
      for (const stmt of node.statements) {
        this.traverseForCommandReturns(stmt, commandInfo, state);
      }
    }
  }

  /**
   * Extract goto targets from Command goto argument
   */
  extractGotoTargets(gotoNode, state) {
    const targets = [];

    if (!gotoNode) return targets;

    // String literal: goto="next_node"
    if (gotoNode.type === "StringLiteral") {
      targets.push(gotoNode.value);
    }
    // Identifier: goto=END
    else if (gotoNode.type === "Identifier") {
      targets.push(gotoNode.name);
    }
    // List: goto=["node_a", "node_b"]
    else if (gotoNode.type === "ListLiteral" || gotoNode.type === "List") {
      if (gotoNode.elements) {
        for (const elem of gotoNode.elements) {
          const target =
            this.extractStringValue(elem) || this.extractNodeName(elem);
          if (target) targets.push(target);
        }
      }
    }

    return targets;
  }

  /**
   * Extract destinations from path_map (dict or list)
   */
  extractDestinationsFromPathMap(pathMap, state) {
    const destinations = [];

    if (!pathMap) return destinations;

    // List form: ["node_a", "node_b"]
    if (
      pathMap.vtype === "list" ||
      (pathMap.value && Array.isArray(pathMap.value))
    ) {
      const items = pathMap.value || [];
      for (const item of items) {
        const dest = this.extractNodeName(item);
        if (dest) destinations.push(dest);
      }
    }
    // Dict form: {"condition_a": "node_a", "condition_b": "node_b"}
    else if (pathMap.vtype === "object") {
      // Extract values from dict
      if (pathMap.field) {
        for (const [key, val] of Object.entries(pathMap.field)) {
          const dest = this.extractNodeName(val);
          if (dest) destinations.push(dest);
        }
      }
    }

    return destinations;
  }

  /**
   * Analyze path function for possible return values
   */
  analyzePathFunction(pathFunc, state) {
    const destinations = [];

    if (!pathFunc || !pathFunc.fdef) return destinations;

    // Traverse function definition for return statements
    const returns = this.findReturnStatements(pathFunc.fdef);

    for (const retNode of returns) {
      if (retNode.value) {
        const dest = this.extractNodeName(retNode.value);
        if (dest) destinations.push(dest);
      }
    }

    return destinations;
  }

  /**
   * Find all return statements in a function
   */
  findReturnStatements(funcNode) {
    const returns = [];

    const traverse = (node) => {
      if (!node) return;

      if (node.type === "ReturnStatement") {
        returns.push(node);
      }

      if (node.body) {
        if (Array.isArray(node.body)) {
          node.body.forEach(traverse);
        } else {
          traverse(node.body);
        }
      }

      if (node.statements) {
        node.statements.forEach(traverse);
      }
    };

    traverse(funcNode);
    return returns;
  }

  /**
   * Extract LLM model name from instantiation
   */
  extractLLMModelName(astNode, state) {
    if (!astNode || astNode.type !== "FunctionCall") return null;

    const args = astNode.args;
    if (!args) return null;

    for (const arg of args) {
      if (arg.type === "KeywordArgument" && arg.arg === "model") {
        return this.extractStringValue(arg.value);
      }
    }

    return null;
  }

  /**
   * Extract create_react_agent info (llm, tools, prompt)
   */
  extractReactAgentInfo(astNode, state) {
    const info = {
      llm: null,
      tools: [],
      systemPrompt: null,
    };

    if (!astNode || astNode.type !== "FunctionCall") return info;

    const args = astNode.args;
    if (!args) return info;

    for (const arg of args) {
      if (arg.type === "KeywordArgument") {
        if (arg.arg === "tools") {
          // Extract tool names from list
          info.tools = this.extractToolNames(arg.value, state);
        } else if (arg.arg === "prompt") {
          info.systemPrompt = this.extractStringValue(arg.value);
        }
      } else {
        // Positional arg: first is llm
        if (info.llm === null && arg.type === "Identifier") {
          info.llm = arg.name;
        }
      }
    }

    return info;
  }

  /**
   * Extract tool names from a list
   */
  extractToolNames(toolsNode, state) {
    const tools = [];

    if (!toolsNode) return tools;

    if (toolsNode.type === "ListLiteral" || toolsNode.type === "List") {
      if (toolsNode.elements) {
        for (const elem of toolsNode.elements) {
          if (elem.type === "Identifier") {
            tools.push(elem.name);
          } else if (elem.name) {
            tools.push(elem.name);
          }
        }
      }
    }

    return tools;
  }

  /**
   * Find agent info associated with a node function
   */
  findAgentInfoForNode(nodeFunc, state) {
    if (!nodeFunc) return null;

    const funcName = this.getFunctionNameFromValue(nodeFunc);
    if (!funcName) return null;

    // Check if this function name matches a react agent variable
    for (const [agentVar, agentInfo] of this.reactAgents) {
      if (funcName.includes(agentVar) || agentVar.includes(funcName)) {
        return agentInfo;
      }
    }

    return null;
  }

  /**
   * Build final ADG structure from collected data
   */
  buildADG(graphName, graphData) {
    const adg = {
      id: graphName,
      name: graphName,
      nodes: [],
      edges: [],
      conditionalEdges: [],
      commandEdges: [],
      entryPoint: graphData.entryPoint,
    };

    // Add START and END nodes
    adg.nodes.push({ name: "START", type: "entry" });
    adg.nodes.push({ name: "END", type: "exit" });

    // Add regular nodes
    for (const [nodeName, nodeInfo] of graphData.nodes) {
      adg.nodes.push({
        name: nodeName,
        type: nodeInfo.isAgent ? "agent" : "node",
        functionName: nodeInfo.functionName,
        agentInfo: nodeInfo.agentInfo,
      });
    }

    // Add edges
    adg.edges = graphData.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: "control_flow",
    }));

    // Add conditional edges
    adg.conditionalEdges = graphData.conditionalEdges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: "conditional",
      condition: edge.condition,
    }));

    // Add command edges (dynamic routing)
    adg.commandEdges = graphData.commandEdges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: "command",
      gotoTargets: edge.gotoTargets,
      isDynamic: edge.isDynamic,
      hasStateUpdate: edge.hasStateUpdate,
      targetGraph: edge.targetGraph,
    }));

    return adg;
  }
}

module.exports = LangGraphADGChecker;
