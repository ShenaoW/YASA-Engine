const pathMod = require('path')
const fs = require('fs-extra')
const yaml = require('js-yaml')
const OutputStrategy = require('../../../engine/analyzer/common/output-strategy')
const logger = require('../../../util/logger')(__filename)

/**
 * Output strategy for LangGraph Agent Dependency Graph (YAML format with variable references)
 * Outputs ADG in YAML format with ${variable} style references
 * Uses variable references like ${llms.claude} to represent:
 * - Node -> Agent references
 * - Agent -> LLM references  
 * - Agent -> Tools references
 */
class LangGraphADGYAMLOutputStrategy extends OutputStrategy {
  static outputStrategyId = 'langgraph_adg_yaml'

  /**
   * Constructor
   */
  constructor() {
    super()
    this.outputFilePath = 'langgraph-adg.yaml'
  }

  /**
   * Get output file path
   */
  getOutputFilePath(): string {
    return this.outputFilePath
  }

  /**
   * Output LangGraph ADG findings to YAML file with anchors and aliases
   *
   * @param {ResultManager} resultManager
   * @param {string} outputFilePath
   * @param {object} config
   * @param {function} printf
   */
  outputFindings(resultManager: any, outputFilePath: any, config: any, printf: any) {
    const allFindings = resultManager.getFindings()

    if (!allFindings) {
      logger.warn('[LangGraph ADG YAML] No findings to output')
      return
    }

    logger.debug(`[LangGraph ADG YAML] All findings keys: ${Object.keys(allFindings).join(', ')}`)

    const findings = allFindings['langgraph_adg'] || allFindings[LangGraphADGYAMLOutputStrategy.outputStrategyId]

    if (!findings || findings.length === 0) {
      logger.warn(`[LangGraph ADG YAML] No LangGraph ADG findings generated. Available keys: ${Object.keys(allFindings).join(', ')}`)
      return
    }

    logger.info(`[LangGraph ADG YAML] Found ${findings.length} finding(s)`)

    if (!config.reportDir) {
      logger.warn('[LangGraph ADG] No report directory specified')
      return
    }

    try {
      const finding = findings[0] // Should be a single finding with all graphs
      const adgFilePath = pathMod.join(config.reportDir, outputFilePath)

      logger.info(`[LangGraph ADG YAML] Writing ADG to ${adgFilePath}`)
      logger.info(`[LangGraph ADG YAML] Report directory: ${config.reportDir}`)
      logger.info(`[LangGraph ADG YAML] Output file path: ${outputFilePath}`)

      // Ensure directory exists
      fs.ensureDirSync(config.reportDir)

      // Build YAML structure with variable references
      const yamlData = this.buildYAMLWithVariableReferences(finding)

      logger.info(`[LangGraph ADG YAML] Output data: ${JSON.stringify({
        graphs: yamlData.summary.totalGraphs,
        agents: yamlData.summary.totalAgents,
        tools: yamlData.summary.totalTools,
        llms: yamlData.summary.totalLLMs,
      })}`)

      // Write to YAML file with variable references
      const yamlContent = yaml.dump(yamlData, {
        indent: 2,
        lineWidth: -1,
        noRefs: false,
        sortKeys: false,
      })

      fs.writeFileSync(adgFilePath, yamlContent, 'utf8')

      logger.info(`[LangGraph ADG YAML] Successfully wrote ADG to ${adgFilePath}`)
      logger.info(`[LangGraph ADG YAML] File size: ${yamlContent.length} bytes`)

      // Verify file was written
      if (fs.existsSync(adgFilePath)) {
        logger.info(`[LangGraph ADG YAML] File exists at ${adgFilePath}`)
      } else {
        logger.error(`[LangGraph ADG YAML] File was not created at ${adgFilePath}`)
      }

      // Also log summary to console
      printf(`\n[LangGraph ADG YAML Analysis Summary]`)
      printf(`  Graphs: ${yamlData.summary.totalGraphs}`)
      printf(`  Agents: ${yamlData.summary.totalAgents}`)
      printf(`  Tools: ${yamlData.summary.totalTools}`)
      printf(`  LLMs: ${yamlData.summary.totalLLMs}`)
      printf(`  Output: ${adgFilePath}\n`)
    } catch (error: any) {
      logger.error(`[LangGraph ADG YAML] Error writing output: ${error.message}`)
      logger.error(`[LangGraph ADG YAML] Error stack: ${error.stack}`)
      printf(`\n[LangGraph ADG YAML] ERROR: Failed to write output file: ${error.message}\n`)
    }
  }

  /**
   * Build YAML structure with variable references using ${variable} syntax
   * Uses variable references like ${llms.claude} to represent:
   * - Node -> Agent references: ${agents.researcher}
   * - Agent -> LLM references: ${llms.claude}
   * - Agent -> Tools references: ${tools.search}
   */
  buildYAMLWithVariableReferences(finding: any) {
    // Create maps for namespace to name (for YAML keys)
    const llmVarMap = new Map() // llm namespace -> name key
    const toolVarMap = new Map() // tool namespace -> name key
    const agentVarMap = new Map() // agent name -> name key (agents already use name as key)

    // Build LLMs as a map with names as keys
    const llmsMap: any = {}
    if (finding.llms) {
      for (const llm of finding.llms) {
        const key = llm.name  // Use name as key
        llmVarMap.set(llm.namespace, key)  // Map namespace to name for variable references
        llmsMap[key] = {
          namespace: llm.namespace,
          modelName: llm.modelName,
        }
      }
    }

    // Build Tools as a map with names as keys
    const toolsMap: any = {}
    if (finding.tools) {
      for (const tool of finding.tools) {
        const key = tool.name  // Use name as key
        toolVarMap.set(tool.namespace, key)  // Map namespace to name for variable references
        toolsMap[key] = {
          namespace: tool.namespace,
          type: tool.type,
          codeSnippet: tool.codeSnippet || null,
        }
      }
    }

    // Build Agents as a map with variable references
    const agentsMap: any = {}
    if (finding.agents) {
      for (const agent of finding.agents) {
        // Agent names are already clean, use directly
        const key = agent.name
        agentVarMap.set(agent.name, key)

        const agentData: any = {
          name: agent.name,
        }

        // Reference LLM using ${llms.key}
        if (agent.llm && llmVarMap.has(agent.llm)) {
          agentData.llm = `\${llms.${llmVarMap.get(agent.llm)}}`
        } else {
          agentData.llm = agent.llm
        }

        // Reference Tools using ${tools.key}
        if (agent.tools && Array.isArray(agent.tools)) {
          agentData.tools = agent.tools.map((toolName: string) => {
            if (toolVarMap.has(toolName)) {
              return `\${tools.${toolVarMap.get(toolName)}}`
            }
            return toolName
          })
        } else {
          agentData.tools = agent.tools
        }

        if (agent.systemPrompt !== undefined) {
          agentData.systemPrompt = agent.systemPrompt
        }

        agentsMap[key] = agentData
      }
    }

    // Build Graphs with node -> agent references
    const graphsWithReferences: any[] = []
    if (finding.graphs) {
      for (const graph of finding.graphs) {
        const graphData: any = {
          id: graph.id,
          name: graph.name,
          entryPoint: graph.entryPoint,
          nodes: [],
          edges: graph.edges || [],
          conditionalEdges: graph.conditionalEdges || [],
          commandEdges: graph.commandEdges || [],
        }

        if (graph.interruptPoints) {
          graphData.interruptPoints = graph.interruptPoints
        }

        // Build nodes with agent references
        if (graph.nodes) {
          for (const node of graph.nodes) {
            const nodeData: any = {
              name: node.name,
              type: node.type,
            }

            // Reference Agent using ${agents.key} if node has an agent
            if (node.agent && agentVarMap.has(node.agent)) {
              nodeData.agent = `\${agents.${agentVarMap.get(node.agent)}}`
            } else if (node.agent) {
              nodeData.agent = node.agent
            }

            if (node.agentInfo) {
              nodeData.agentInfo = node.agentInfo
            }

            graphData.nodes.push(nodeData)
          }
        }

        graphsWithReferences.push(graphData)
      }
    }

    // Build final structure with maps for variable references
    return {
      framework: 'langgraph',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      summary: {
        totalGraphs: graphsWithReferences.length,
        totalAgents: Object.keys(agentsMap).length,
        totalTools: Object.keys(toolsMap).length,
        totalLLMs: Object.keys(llmsMap).length,
      },
      llms: llmsMap,
      tools: toolsMap,
      agents: agentsMap,
      graphs: graphsWithReferences,
    }
  }

  /**
   * Sanitize key for use in YAML variable references
   * Converts special characters to underscores
   */
  sanitizeKey(key: string): string {
    if (!key) return 'unknown'
    // Replace special characters with underscores, keep alphanumeric and dots
    return key.replace(/[^a-zA-Z0-9._]/g, '_').replace(/^[^a-zA-Z_]/, '_$&')
  }
}

module.exports = LangGraphADGYAMLOutputStrategy

