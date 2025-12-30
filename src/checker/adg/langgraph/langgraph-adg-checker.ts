const _ = require('lodash')
const Checker = require('../../common/checker')
const LangGraphADGOutputStrategy = require('../../common/output/langgraph-adg-output-strategy')
const constValue = require('../../../util/constant')
const astUtil = require('../../../util/ast-util')
const logger = require('../../../util/logger')(__filename)
const config = require('../../../config')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const { extractRelativePath } = require('../../../util/file-util')
const SourceLine = require('../../../engine/analyzer/common/source-line')
const {
  determineToolType,
  extractToolCodeSnippet,
  extractVariableName,
  extractStringValue,
  extractNodeName,
  computeValue,
  isStateGraphInstance,
  isAgentCreationMethod,
} = require('./langgraph-adg-utils')

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
  constructor(resultManager: any) {
    super(resultManager, 'langgraph_adg')

    // =========================== YASA Context Variables ===========================
    // Entry points for analysis
    this.entryPoints = [];

    // Current analysis state (updated in each triggerXXX method)
    this.analyzer = null;
    this.scope = null;
    this.node = null;
    this.state = null;
    this.info = null;

    // ========================= LangGraph Context Variables =========================
    // Track StateGraph instances: { graphVarName: { graphSymbol, nodes, edges, config } }
    this.graphs = new Map();

    // Track agent definitions: { nodeName: { llm, tools, systemPrompt, nodeFunction } }
    this.agents = new Map();

    // Track tools discovered in the code
    this.tools = new Map();

    // Track LLM instances
    this.llms = new Map();

    // Track bind_tools calls: { agentVarName: { llmVar, tools: [...] } }
    this.boundAgents = new Map();

    // Track interrupt points: { nodeName: [interruptInfo] }
    this.interruptPoints = new Map();

  }

  // ==================== State Management ====================

  /**
   * Update current analysis state from triggerXXX method parameters
   * This ensures all methods can access current analyzer, scope, node, state, and info
   */
  updateContext(analyzer: any, scope: any, node: any, state: any, info: any) {
    this.analyzer = analyzer;
    this.scope = scope;
    this.node = node;
    this.state = state;
    this.info = info;
  }

  // ==================== YASA Lifecycle Hooks ====================

  /**
   * Trigger at start of analysis to initialize tracking
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    this.updateContext(analyzer, scope, node, state, info);
    logger.info('[LangGraph ADG] Starting analysis...')

    // Prepare entry points for analysis
    this.prepareEntryPoints(analyzer)

    // Add entry points to analyzer
    if (this.entryPoints) {
      analyzer.entryPoints.push(...this.entryPoints)
      logger.info(`[LangGraph ADG] Added ${this.entryPoints.length} entry point(s)`)
    } else {
      logger.warn('[LangGraph ADG] No entry points found, analysis may not work properly')
    }
  }

  /**
   * Prepare entry points by scanning all Python files in the directory
   */
  prepareEntryPoints(analyzer: any) {
    const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      // use callgraph root nodes as entrypoint
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer);
      const fullCallGraphEntrypoint =
        fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
          analyzer.ainfo?.callgraph
        );
      // use file top-level code as entrypoint
      const fullFileEntrypoint =
        fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(
          analyzer.fileManager
        );
      this.entryPoints.push(...fullFileEntrypoint);
      this.entryPoints.push(...fullCallGraphEntrypoint);
    }
  }

  /**
   * Trigger before function calls to detect add_node, add_edge, etc.
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    this.updateContext(analyzer, scope, node, state, info);
    if (!node || (node.type !== 'FunctionCall' && node.type !== 'CallExpression')) return

    const { fclos, argvalues } = info || {}

    let funcName = fclos.qid

    if (!funcName) {
      return;
    }

    logger.debug(`[LangGraph ADG] Function call detected: ${funcName}`);

    // ==================== Graph Instantiation ====================
    // Detect: workflow = StateGraph(MessagesState)
    // Check if this function call is StateGraph instantiation in an assignment
    if (isStateGraphInstance(node)) {
      const parent = node.parent;
      if (parent && parent.type === 'AssignmentExpression' && parent.left) {
        const graphVarName = extractVariableName(parent.left);
        if (graphVarName) {
          logger.info(`[LangGraph ADG] Found StateGraph instance: ${graphVarName}`);
          this.graphs.set(graphVarName, {
            graphVarName: graphVarName,
            graphSymbolVal: node.callee?.name || funcName,
            nodes: new Map(),
            edges: [],
            conditionalEdges: [],
            commandEdges: [],
            entryPoint: null,
            astNode: parent,
          });
        }
      }
    }

    // ==================== Graph Context ====================
    // Detect: workflow.add_node("researcher", research_node)
    if (funcName.endsWith('add_node')) {
      this.handleAddNode(node, state, argvalues, info)
    }

    // Detect: workflow.add_edge(START, "researcher")
    else if (funcName.endsWith('add_edge')) {
      this.handleAddEdge(node, state, argvalues)
    }

    // Detect: workflow.add_conditional_edges(...)
    // TODO: check this
    else if (funcName.endsWith('add_conditional_edges')) {
      this.handleAddConditionalEdges(node, state, argvalues)
    }

    // Detect: workflow.add_sequence([node1, node2, node3])
    // TODO: check this
    else if (funcName.endsWith('add_sequence')) {
      this.handleAddSequence(node, state, argvalues)
    }

    // Detect: workflow.set_entry_point("researcher") or graph.add_edge(START, ...)
    else if (funcName.endsWith('set_entry_point')) {
      this.handleSetEntryPoint(node, state, argvalues)
    }

    // Detect: interrupt(...) calls in node functions
    else if (funcName.endsWith('interrupt')) {
      this.handleInterrupt(node, state, argvalues)
    }

    // ==================== Agent Creation ====================
    // Detect: create_XXX_agent calls
    // At this point, argvalues contains symbol values from YASA's pointer analysis
    if (isAgentCreationMethod(funcName)) {
      this.handleAgentCreationCall(node, state, argvalues, info, funcName);
    }

    // Detect (Tool Binding Model): 
    // model = llm.bind_tools([...])
    // response = model.invoke(messages)
    // TODO: 其实也只是一个匿名变量llm_with_tools，暂时先绑定到runnable上
    else if (fclos.type === 'MemberAccess' && funcName.endsWith('bind_tools')) {
      this.handleBindTools(node, argvalues, fclos)
    }
  }

  /**
   * Trigger at end of analysis to build final ADG and output results
   */
  triggerAtEndOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    this.updateContext(analyzer, scope, node, state, info);
    logger.info('[LangGraph ADG] Building final Agent Dependency Graph...')

    const adgs = [];

    for (const [graphName, graphData] of this.graphs) {
      const adg = this.buildADG(graphName, graphData);
      adgs.push(adg);
    }

    if (adgs.length > 0) {
      // Clean agents: remove circular references
      const cleanAgents = Array.from(this.agents.values()).map((agent: any) => ({
        name: agent.name,
        llm: agent.llm,
        tools: agent.tools,
        systemPrompt: agent.systemPrompt,
      }));

      // Clean tools: remove circular references
      const cleanTools = Array.from(this.tools.values()).map((tool: any) => ({
        name: tool.name,
        type: tool.type,
        codeSnippet: tool.codeSnippet || null,
      }));

      // Clean LLMs: remove circular references
      const cleanLLMs = Array.from(this.llms.values()).map((llm: any) => ({
        varName: llm.varName,
        modelName: llm.modelName,
      }));

      const finding = {
        type: this.getCheckerId(),
        graphs: adgs,
        agents: cleanAgents,
        tools: cleanTools,
        llms: cleanLLMs,
      };

      this.resultManager.newFinding(
        finding,
        'langgraph_adg'
      );
      logger.info(`[LangGraph ADG] Generated ${adgs.length} ADG(s)`);
    } else {
      logger.warn("[LangGraph ADG] No LangGraph graphs found in the codebase");
    }
  }

  // ==================== Handler Methods ====================

  /**
   * Handle add_node call
   * Supports: add_node(name, function) or add_node(function)
   */
  handleAddNode(node: any, state: any, argvalues: any, info: any) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) {
      logger.debug(
        "[LangGraph ADG] add_node called but graph instance not found"
      );
      return;
    }

    let nodeName, nodeFunction;

    // Try to extract from argvalues first
    if (argvalues && argvalues.length >= 2) {
      // Form: add_node("researcher", research_node)
      const nameArg = argvalues[0];
      const funcArg = argvalues[1];

      nodeName = computeValue(nameArg);
      nodeFunction = funcArg;
    } else if (argvalues && argvalues.length === 1) {
      // Form: add_node(research_node)
      // name is inferred from function name
      nodeFunction = argvalues[0];
      nodeName = computeValue(nodeFunction).split(".").pop();
    }

    if (!nodeName) {
      logger.warn(
        "[LangGraph ADG] Could not extract node name from add_node call"
      );
      return;
    }

    logger.info(`[LangGraph ADG] Adding node: ${nodeName}`);

    const nodeInfo: any = {
      name: nodeName,
      nodeFunction: nodeFunction,
      functionName: computeValue(nodeFunction),
      astNode: node,
      isAgent: false,
      agentInfo: null,
      commandGotoTargets: null,
    };

    // Analyze node function's AST to find agent.invoke() calls and Command returns
    // Use nodeFunction.fdef to get the FunctionDefinition node
    const funcDefNode = nodeFunction?.fdef;
    let agentInfo = null;
    let commandInfo = null;

    if (funcDefNode) {
      // Analyze function body AST to find agent.invoke() calls
      const agentVar = this.findAgentVariableInFunctionBody(funcDefNode, state);
      if (agentVar) {
        logger.debug(`[LangGraph ADG] Node ${nodeName} function uses agent/runnable: ${agentVar}`);
        
        // Check if this agent variable matches an agent
        if (this.agents.has(agentVar)) {
          const agent = this.agents.get(agentVar);
          agentInfo = {
            llm: agent.llm,
            tools: agent.tools || [],
            systemPrompt: agent.systemPrompt,
          };
        }
        // Check if this agent variable matches a bound agent
        else if (this.boundAgents.has(agentVar)) {
          const boundAgent = this.boundAgents.get(agentVar);
          agentInfo = {
            llm: boundAgent.llmVar,
            tools: boundAgent.tools,
            systemPrompt: null,
          };
        }
      }

      if (agentInfo) {
        nodeInfo.isAgent = true;
        nodeInfo.agentInfo = agentInfo;
      }

      // Analyze function body AST to find Command returns
      commandInfo = this.findCommandReturnAnnotation(funcDefNode, state);
      if (commandInfo && commandInfo.hasCommand) {
        logger.info(
          `[LangGraph ADG] Node ${nodeName} function returns Command with goto: ${JSON.stringify(commandInfo.gotoTargets)}`
        );

        nodeInfo.commandGotoTargets = commandInfo.gotoTargets;

      }
    }

    graphInstance.nodes.set(nodeName, nodeInfo);

    // Create command edges if function returns Command (analyzed above)
    if (commandInfo && commandInfo.hasCommand) {
      for (const target of commandInfo.gotoTargets) {
        graphInstance.commandEdges.push({
          from: nodeName,
          to: target,
        });
      }
    }
  }

  /**
   * Handle add_edge call
   * Form: add_edge(start, end) or add_edge(START, "node")
   */
  handleAddEdge(node: any, state: any, argvalues: any) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) {
      logger.debug("[LangGraph ADG] add_edge called but graph instance not found");
      return;
    }

    let startNode, endNode;

    // Try to extract from argvalues first
    if (argvalues && argvalues.length >= 2) {
      startNode = computeValue(argvalues[0]).split(".").pop();
      endNode = computeValue(argvalues[1]).split(".").pop();
    }

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
    });

    // Track entry point if START -> node
    if (startNode === "START") {
      graphInstance.entryPoint = endNode;
      logger.info(`[LangGraph ADG] Entry point set to: ${endNode}`);
    }
  }

  /**
   * Handle add_conditional_edges call
   * Forms:
   * - add_conditional_edges(source, path_function)
   * - add_conditional_edges(source, path_function, path_map)
   */
  handleAddConditionalEdges(node: any, state: any, argvalues: any) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) return;

    if (!argvalues || argvalues.length < 2) {
      logger.warn(
        "[LangGraph ADG] add_conditional_edges requires at least 2 arguments"
      );
      return;
    }

    const sourceNode = computeValue(argvalues[0]).split(".").pop();
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
   * Handle add_sequence call
   * Pattern: graph.add_sequence([node1, node2, node3])
   */
  handleAddSequence(node: any, state: any, argvalues: any) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) return;

    if (!argvalues || argvalues.length < 1) {
      logger.warn("[LangGraph ADG] add_sequence requires at least 1 argument");
      return;
    }

    const sequenceArg = argvalues[0];
    const nodeSequence = this.extractSequenceNodes(sequenceArg, state);

    if (nodeSequence.length < 2) {
      logger.warn("[LangGraph ADG] add_sequence requires at least 2 nodes");
      return;
    }

    logger.info(
      `[LangGraph ADG] Adding sequence: ${nodeSequence.join(' -> ')}`
    );

    // Register nodes if not already present
    for (const nodeName of nodeSequence) {
      if (!graphInstance.nodes.has(nodeName)) {
        graphInstance.nodes.set(nodeName, {
          name: nodeName,
          nodeFunction: null,
          functionName: null,
          astNode: node,
          isAgent: false,
          agentInfo: null,
        });
      }
    }

    // Add edges: n1->n2, n2->n3, ...
    for (let i = 0; i < nodeSequence.length - 1; i++) {
      graphInstance.edges.push({
        from: nodeSequence[i],
        to: nodeSequence[i + 1],
        astNode: node,
      });
    }
  }

  /**
   * Handle set_entry_point call
   */
  handleSetEntryPoint(node: any, state: any, argvalues: any) {
    const graphInstance = this.findGraphInstance(node, state);
    if (!graphInstance) return;

    if (!argvalues || argvalues.length < 1) return;

    const entryNode = computeValue(argvalues[0]).split(".").pop();
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
   * Handle interrupt call
   * Pattern: interrupt(...) in node functions
   */
  handleInterrupt(node: any, state: any, argvalues: any) {
    // Find which node function we're currently in
    // This requires tracking the current function context
    // For now, we'll mark it and process later
    logger.debug("[LangGraph ADG] Found interrupt() call");
    
    // Store interrupt info for later processing
    if (!this.interruptPoints) {
      this.interruptPoints = new Map();
    }
    
    // Try to find current function context from state
    const currentFunc = this.getCurrentFunctionContext(state);
    if (currentFunc) {
      if (!this.interruptPoints.has(currentFunc)) {
        this.interruptPoints.set(currentFunc, []);
      }
      this.interruptPoints.get(currentFunc).push({
        astNode: node,
        argvalues: argvalues,
      });
    }
  }

  /**
   * Handle agent creation call in triggerAtFunctionCallBefore
   * At this point, argvalues contains symbol values from YASA's pointer analysis
   * Directly extracts agentVarName from parent assignment expression if available
   */
  handleAgentCreationCall(node: any, state: any, argvalues: any[], info: any, funcName: string) {
    let agentVarName: string | null = null;
    
    if (node.parent && 
        node.parent.type === 'AssignmentExpression' && 
        node.parent.operator === '=' &&
        node.parent.left && 
        node.parent.left.type === 'Identifier') {
      agentVarName = node.parent.left.name;
      logger.debug(`[LangGraph ADG] Found agent variable name from assignment: ${agentVarName}`);
    }

    // If not in assignment, skip (agent creation without assignment is not tracked)
    if (!agentVarName) {
      logger.debug(`[LangGraph ADG] Agent creation call not in assignment expression, skipping`);
      return;
    }

    logger.info(`[LangGraph ADG] Processing agent creation: ${agentVarName}`);

    // Register agent (extracts info and registers LLM, tools, and agent)
    this.registerAgent(agentVarName, node, argvalues, state);
  }

  /**
   * Handle bind_tools call in ChatModel
   * Pattern: llm_with_tools = llm.bind_tools([tool1, tool2, ...])
   */
  handleBindTools(node: any, argvalues: any, fclos: any) {
    // Define variables outside block scope for use after conditional
    let toolCallingLLMName: string = "anonymous_var";
    let runnableVarName: string = "anonymous_var";

    if (node.parent.type === 'BinaryExpression' && node.parent.operator === '|' &&
        node.parent.parent.type === 'AssignmentExpression') {
      toolCallingLLMName = "anonymous_var";
      runnableVarName = node.parent.parent.left.name;
    } else if (node.parent.type === 'AssignmentExpression') {
      toolCallingLLMName = node.parent.left.name;
      runnableVarName = "anonymous_var";
    }

    const llmVarName = fclos.qid.replace(/\.bind_tools$/, "");
    const toolSetValue = argvalues[0];
    const tools = computeValue(toolSetValue);

    if (llmVarName && toolSetValue.length > 0) {
      logger.info(
        `[LangGraph ADG] Found bind_tools call: ${llmVarName}.bind_tools([${tools.join(', ')}])`
      );
    }
    
    this.boundAgents.set(runnableVarName, {
      llmVar: llmVarName,
      tools: tools,
      agentVar: runnableVarName,
    });

    this.agents.set(runnableVarName, {
      name: runnableVarName,
      llm: llmVarName,
      tools: tools,
      // TODO: set system prompt via invoke call
      systemPrompt: null,
    })

    // Register tools
    this.registerTools(toolSetValue);
  }

  // ==================== Helper Methods ====================
  
  /**
   * Find the graph instance that the current method call belongs to
   */
  findGraphInstance(node: any, state: any) {
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

    return null;
  }

  /**
   * Analyze function return type annotation for Command[Literal["node_name"]]
   * According to LangGraph docs, Command return type must be annotated with the list of node names,
   * e.g., Command[Literal["my_other_node"]]
   */
  findCommandReturnAnnotation(funcDefNode: any, state: any) {
    if (!funcDefNode) {
      return null;
    }

    // Get return type annotation from function definition
    // Python: returns field (Python 3.5+)
    // UAST might have: returnType, returnParameters, returns
    const returnType = funcDefNode.return_type;
    if (!returnType) {
      logger.debug(`[LangGraph ADG] Function has no return type annotation`);
      return null;
    }

    const commandInfo = {
      hasCommand: false,
      gotoTargets: [] as string[],
    };

    // Parse return type annotation to find Command[Literal[...]]
    if (returnType.id.name === "Command") {
      commandInfo.hasCommand = true;
      if (returnType.typeArguments && returnType.typeArguments.length === 1) {
        const typeArgument = returnType.typeArguments[0];
        if (typeArgument.id.name === "Literal") {
          for (const gotoTarget of typeArgument.typeArguments) {
            if (gotoTarget.type === "Literal") {
              commandInfo.gotoTargets.push(gotoTarget.value);
            }
            else if (gotoTarget.type === "Identifier") {
            commandInfo.gotoTargets.push(gotoTarget.name);
            }
          }
        }
      }
    }
    return commandInfo;
  }

  /**
   * Extract destinations from path_map (dict or list)
   */
  extractDestinationsFromPathMap(pathMap: any, state: any) {
    const destinations: any[] = [];

    if (!pathMap) return destinations;

    // List form: ["node_a", "node_b"]
    if (
      pathMap.vtype === "list" ||
      (pathMap.value && Array.isArray(pathMap.value))
    ) {
      const items = pathMap.value || [];
      for (const item of items) {
        const dest = extractNodeName(item);
        if (dest) destinations.push(dest);
      }
    }
    // Dict form: {"condition_a": "node_a", "condition_b": "node_b"}
    else if (pathMap.vtype === "object") {
      // Extract values from dict
      if (pathMap.field) {
        for (const [key, val] of Object.entries(pathMap.field)) {
          const dest = extractNodeName(val);
          if (dest) destinations.push(dest);
        }
      }
    }

    return destinations;
  }

  /**
   * Analyze path function for possible return values
   */
  analyzePathFunction(pathFunc: any, state: any) {
    const destinations: any[] = [];

    if (!pathFunc || !pathFunc.fdef) return destinations;

    // Traverse function definition for return statements
    const returns = this.findReturnStatements(pathFunc.fdef);

    for (const retNode of returns) {
      if (retNode.value) {
        const dest = extractNodeName(retNode.value);
        if (dest) destinations.push(dest);
      }
    }

    return destinations;
  }

  /**
   * Find all return statements in a function
   */
  findReturnStatements(funcNode: any) {
    const returns: any[] = [];

    const traverse = (node: any) => {
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
   * Find agent info associated with a node function
   * Checks if the function calls agent.invoke() and matches it to known agents
   */
  findAgentInfoForNode(nodeFunc: any, state: any) {
    if (!nodeFunc) return null;

    const funcName = computeValue(nodeFunc).split(".").pop();
    if (!funcName) return null;

    // Check if function body contains agent.invoke() calls
    const agentVar = this.findAgentVariableInFunction(nodeFunc, state);
    if (agentVar) {
      // Check if this agent variable matches an agent
      if (this.agents.has(agentVar)) {
        const agent = this.agents.get(agentVar);
        return {
          llm: agent.llm,
          tools: agent.tools || [],
          systemPrompt: agent.systemPrompt,
        };
      }
      // Check if this agent variable matches a bound agent
      if (this.boundAgents.has(agentVar)) {
        const boundAgent = this.boundAgents.get(agentVar);
        return {
          llm: boundAgent.llmVar,
          tools: boundAgent.tools,
          systemPrompt: null,
        };
      }
    }

    // Fallback: Check if function name matches an agent variable
    for (const [agentVar, agent] of this.agents) {
      if (funcName.includes(agentVar) || agentVar.includes(funcName)) {
        return {
          llm: agent.llm,
          tools: agent.tools || [],
          systemPrompt: agent.systemPrompt,
        };
      }
    }

    // Fallback: Check if function name matches a bound agent variable
    for (const [agentVar, boundAgent] of this.boundAgents) {
      if (funcName.includes(agentVar) || agentVar.includes(funcName)) {
        return {
          llm: boundAgent.llmVar,
          tools: boundAgent.tools,
          systemPrompt: null,
        };
      }
    }

    return null;
  }

  /**
   * Find agent variable name from function definition body by looking for agent.invoke() or runnable.invoke() calls
   * Uses astUtil.visit to traverse all AST nodes, including AssignmentExpression.right
   */
  findAgentVariableInFunctionBody(funcDefNode: any, state: any) {
    if (!funcDefNode) return null;

    // Get function body - could be in different places
    const body = funcDefNode.body;
    if (!body) return null;

    let agentVar: string | null = null;

    // Use astUtil.visit to traverse all AST nodes automatically
    astUtil.visit(body, {
      CallExpression: (node: any) => {
        if (agentVar) return false;
        return this.checkInvokeCall(node, (varName: string) => {
          agentVar = varName;
        });
      }
    });

    return agentVar;
  }

  /**
   * Check if a call node is an invoke call and extract agent variable
   * @param node - The call node to check
   * @param onFound - Callback when agent variable is found
   * @returns false to stop traversal if agent variable is found, true to continue
   */
  checkInvokeCall(node: any, onFound: (varName: string) => void): boolean {
    const callee = node.callee || node.func;
    if (!callee) return true; // Continue traversal

    // Python: Attribute (obj.method)
    if (callee.type === "Attribute" || callee.type === "MemberAccess") {
      const attr = callee.attr || callee.property;
      const attrName = attr?.name || attr?.id?.name || attr;
      if (attrName === "invoke") {
        const objectNode = callee.value || callee.object;
        if (objectNode) {
          const varName = objectNode.sid || objectNode.name || 
                         (objectNode.id && objectNode.id.name) ||
                         (objectNode.type === "Identifier" && objectNode.name) ||
                         (objectNode.type === "Name" && objectNode.id?.name);
          if (varName) {
            logger.debug(`[LangGraph ADG] Found agent.invoke() call with agent variable: ${varName}`);
            onFound(varName);
            return false; // Stop traversal
          }
        }
      }
    }
    return true; // Continue traversal
  }

  /**
   * Extract node sequence from add_sequence argument
   * Supports: [node1, node2, node3] or [(name1, func1), (name2, func2)]
   */
  extractSequenceNodes(sequenceArg: any, state: any) {
    const nodes: any[] = [];

    if (!sequenceArg) return nodes;

    // List form: [node1, node2, node3]
    if (sequenceArg.vtype === "list" || (sequenceArg.value && Array.isArray(sequenceArg.value))) {
      const items = sequenceArg.value || sequenceArg.elements || [];
      for (const item of items) {
        // Handle tuple form: (name, function)
        if (item.type === "Tuple" || (Array.isArray(item) && item.length === 2)) {
          const nameItem = Array.isArray(item) ? item[0] : (item.elements ? item.elements[0] : null);
          const nodeName = extractStringValue(nameItem) || extractNodeName(nameItem);
          if (nodeName) nodes.push(nodeName);
        } else {
          // Regular node reference
          const nodeName = extractStringValue(item) || extractNodeName(item);
          if (nodeName) nodes.push(nodeName);
        }
      }
    }

    return nodes;
  }

  /**
   * Get current function context from state
   */
  getCurrentFunctionContext(state: any) {
    // Try to get from state's function stack or scope
    if (state && state.functionStack && state.functionStack.length > 0) {
      const topFunc = state.functionStack[state.functionStack.length - 1];
      return topFunc.name || topFunc.id;
    }
    return null;
  }

  // ==================== Agent/Tool/LLM Registration ====================

  /**
   * Register multiple tools from a list
   * 
   * @param toolSetInfo - Array of tool nodes or tool names
   * @returns Array of successfully registered tool names
   */
  registerTools(toolSetInfo: any): string[] {
    const registeredTools: string[] = [];
    // 或者直接用 Object.entries 遍历 toolSet 的 key 和 value
    const toolSet = toolSetInfo.field;
    for (const [key, toolInfo] of Object.entries(toolSet)) {
      const toolName = computeValue(toolInfo);
      if (toolName){
        this.registerTool(toolInfo, toolName);
        registeredTools.push(toolName);
      }
    }
    
    return registeredTools;
  }
  
  
  /**
   * Register a tool in the tools Map
   * 
   * @param toolInfo - YASA memory object representing the tool (can be AST node, symbol value, or function)
   * @param toolName - Name of the tool (if not provided, will try to extract from toolNode)
   * @returns The registered tool name, or null if registration failed
   */
  registerTool(toolInfo: any, toolName: string): string | null {

    // Skip if already registered
    if (this.tools.has(toolName)) {
      logger.debug(`[LangGraph ADG] Tool ${toolName} already registered, skipping`);
      return toolName;
    }

    // Determine tool type
    const toolType = determineToolType(toolName);

    // Extract code snippet
    const codeSnippet = extractToolCodeSnippet(this.analyzer, toolInfo);

    // Register tool
    this.tools.set(toolName, {
      name: toolName,
      type: toolType,
      codeSnippet: codeSnippet,
    });

    logger.debug(`[LangGraph ADG] Registered tool: ${toolName} (type: ${toolType})`);
    return toolName;
  }
  
  /**
   * Register LLM instance
   * @param llmVarName - Variable name of the LLM
   * @param modelName - Model name (e.g., "claude-3-5-sonnet-20241022", "gpt-4")
   * @param astNode - AST node for code snippet extraction (optional)
   */
  registerLLM(llmVarName: string, modelName: string, astNode?: any) {
    if (!llmVarName) return;

    // Skip if already registered
    if (this.llms.has(llmVarName)) {
      // Update model name if we have a better one
      const existing = this.llms.get(llmVarName);
      if (modelName && modelName !== "unknown" && existing.modelName === "unknown") {
        existing.modelName = modelName;
        logger.debug(`[LangGraph ADG] Updated LLM ${llmVarName} model name: ${modelName}`);
      }
      return;
    }

    this.llms.set(llmVarName, {
      varName: llmVarName,
      modelName: modelName || "unknown",
    });

    logger.debug(`[LangGraph ADG] Registered LLM: ${llmVarName} (model: ${modelName || "unknown"})`);
  }

  /**
   * Register agent from agent creation call
   * Extracts agent info, registers LLM, tools, and agent
   * @param agentVarName - Variable name of the agent
   * @param callNode - AST node of the agent creation call
   * @param argvalues - Symbol values from YASA's pointer analysis
   * @param state - Current analysis state
   */
  registerAgent(agentVarName: string, callNode: any, argvalues: any[], state: any) {
    if (!agentVarName || !callNode) return;

    const info: any = {
      llm: null,
      tools: [],
      systemPrompt: null,
    };

    const astArgs = callNode.args || callNode.arguments || [];
    let positionalIndex = 0;

    // Process AST arguments and match with argvalues
    for (let i = 0; i < astArgs.length; i++) {
      const astArg = astArgs[i];
      const argValue = i < argvalues.length ? argvalues[i] : null;

      // Handle keyword arguments: create_react_agent(llm=..., tools=[...], prompt=...)
      if (astArg.type === "KeywordArgument" || 
          (astArg.id && astArg.id.name) ||
          (astArg.keyword && astArg.keyword.name)) {
        const argName = astArg.arg || astArg.id?.name || astArg.keyword?.name;
        if (argName === "llm") {
          const llmResult = computeValue(argValue);
          info.llm = llmResult;
          // Register LLM if not already registered
          if (llmResult && !this.llms.has(llmResult)) {
            this.registerLLM(llmResult, "unknown");
          }
        } else if (argName === "tools") {
          // Register tools
          if (argValue) {
            this.registerTools(argValue);
            // Store tool names in info.tools
            const toolsResult = computeValue(argValue);
            info.tools = Array.isArray(toolsResult) ? toolsResult : (toolsResult ? [toolsResult] : []);
          }
        } else if (argName === "prompt" || argName === "system_prompt") {
          const promptResult = computeValue(argValue || astArg.value || astArg);
          info.systemPrompt = typeof promptResult === "string" ? promptResult : null;
        }
      } else {
        // Handle positional arguments: create_react_agent(..., [...], ...)
        if (positionalIndex === 0) {
          // First positional arg: LLM
          const llmResult = computeValue(argValue);
          info.llm = llmResult;
          // Register LLM if not already registered
          if (llmResult && !this.llms.has(llmResult)) {
            this.registerLLM(llmResult, "unknown");
          }
          positionalIndex++;
        } else if (positionalIndex === 1) {
          // Second positional arg: tools (if not provided as keyword)
          if (argValue) {
            // Register tools
            this.registerTools(argValue);
            // Store tool names in info.tools
            const toolsResult = computeValue(argValue);
            info.tools = Array.isArray(toolsResult) ? toolsResult : (toolsResult ? [toolsResult] : []);
          }
          positionalIndex++;
        } else if (positionalIndex === 2) {
          // Third positional arg: prompt (if not provided as keyword)
          const promptResult = computeValue(argValue);
          info.systemPrompt = typeof promptResult === "string" ? promptResult : null;
          positionalIndex++;
        }
      }
    }

    // Register agent
    if (info.llm || info.tools.length > 0) {
      logger.info(
        `[LangGraph ADG] Registered agent ${agentVarName}: llm=${info.llm}, tools=[${info.tools.join(', ')}]`
      );

      this.agents.set(agentVarName, {
        name: agentVarName,
        llm: info.llm,
        tools: info.tools || [],
        systemPrompt: info.systemPrompt,
      });
    } else {
      logger.warn(`[LangGraph ADG] Could not extract agent info for ${agentVarName}`);
    }
  }

  // ==================== ADG Building ====================
  /**
   * Build final ADG structure from collected data
   */
  buildADG(graphName: any, graphData: any) {
    const adg: any = {
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
      // Clean agentInfo to remove circular references
      let cleanAgentInfo = null;
      if (nodeInfo.agentInfo) {
        cleanAgentInfo = {
          llm: nodeInfo.agentInfo.llm,
          tools: nodeInfo.agentInfo.tools,
          systemPrompt: nodeInfo.agentInfo.systemPrompt,
        };
      }
      adg.nodes.push({
        name: nodeName,
        type: nodeInfo.isAgent ? "agent" : "node",
        functionName: nodeInfo.functionName,
        agentInfo: cleanAgentInfo,
      });
    }

    // Add edges
    adg.edges = graphData.edges.map((edge: any) => ({
      from: edge.from,
      to: edge.to,
      type: "control_flow",
    }));

    // Add conditional edges
    adg.conditionalEdges = graphData.conditionalEdges.map((edge: any) => ({
      from: edge.from,
      to: edge.to,
      type: "conditional",
      condition: edge.condition,
    }));

    // Add command edges (dynamic routing)
    adg.commandEdges = graphData.commandEdges.map((edge: any) => ({
      from: edge.from,
      to: edge.to,
      type: "command",
      gotoTargets: edge.gotoTargets,
      isDynamic: edge.isDynamic,
      hasStateUpdate: edge.hasStateUpdate,
      hasResume: edge.hasResume,
      targetGraph: edge.targetGraph,
    }));

    // Add interrupt points if any
    if (this.interruptPoints && this.interruptPoints.size > 0) {
      adg.interruptPoints = [];
      for (const [funcName, interrupts] of this.interruptPoints) {
        // Find which node uses this function
        for (const [nodeName, nodeInfo] of graphData.nodes) {
          if (nodeInfo.functionName === funcName) {
            adg.interruptPoints.push({
              node: nodeName,
              function: funcName,
              count: interrupts.length,
            });
            break;
          }
        }
      }
    }

    return adg;
  }

}

module.exports = LangGraphADGChecker;
