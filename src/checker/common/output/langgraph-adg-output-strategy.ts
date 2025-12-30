const pathMod = require('path')
const fs = require('fs-extra')
const OutputStrategy = require('../../../engine/analyzer/common/output-strategy')
const logger = require('../../../util/logger')(__filename)

/**
 * Output strategy for LangGraph Agent Dependency Graph
 * Outputs ADG in JSON format compatible with the ADG visualization tools
 */
class LangGraphADGOutputStrategy extends OutputStrategy {
  static outputStrategyId = 'langgraph_adg'

  /**
   * Constructor
   */
  constructor() {
    super()
    this.outputFilePath = 'langgraph-adg.json'
  }

  /**
   * Get output file path
   */
  getOutputFilePath(): string {
    return this.outputFilePath
  }

  /**
   * Output LangGraph ADG findings to JSON file
   *
   * @param {ResultManager} resultManager
   * @param {string} outputFilePath
   * @param {object} config
   * @param {function} printf
   */
  outputFindings(resultManager: any, outputFilePath: any, config: any, printf: any) {
    const allFindings = resultManager.getFindings()

    if (!allFindings) {
      logger.warn('[LangGraph ADG] No findings to output')
      return
    }

    const findings = allFindings[LangGraphADGOutputStrategy.outputStrategyId] || allFindings['langgraph_adg']

    if (!findings || findings.length === 0) {
      logger.warn('[LangGraph ADG] No LangGraph ADG findings generated')
      return
    }

    if (!config.reportDir) {
      logger.warn('[LangGraph ADG] No report directory specified')
      return
    }

    try {
      const finding = findings[0] // Should be a single finding with all graphs
      const adgFilePath = pathMod.join(config.reportDir, outputFilePath)

      logger.info(`[LangGraph ADG] Writing ADG to ${adgFilePath}`)
      logger.info(`[LangGraph ADG] Report directory: ${config.reportDir}`)
      logger.info(`[LangGraph ADG] Output file path: ${outputFilePath}`)

      // Ensure directory exists
      fs.ensureDirSync(config.reportDir)

      // Format the output for better readability
      const output = {
        framework: 'langgraph',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        summary: {
          totalGraphs: finding.graphs ? finding.graphs.length : 0,
          totalAgents: finding.agents ? finding.agents.length : 0,
          totalTools: finding.tools ? finding.tools.length : 0,
          totalLLMs: finding.llms ? finding.llms.length : 0,
        },
        graphs: finding.graphs || [],
        agents: finding.agents || [],
        tools: finding.tools || [],
        llms: finding.llms || [],
      }

      logger.info(`[LangGraph ADG] Output data: ${JSON.stringify({
        graphs: output.summary.totalGraphs,
        agents: output.summary.totalAgents,
        tools: output.summary.totalTools,
        llms: output.summary.totalLLMs,
      })}`)

      // Write to file with pretty printing
      const jsonContent = JSON.stringify(output, null, 2)
      fs.writeFileSync(adgFilePath, jsonContent, 'utf8')

      logger.info(`[LangGraph ADG] Successfully wrote ADG to ${adgFilePath}`)
      logger.info(`[LangGraph ADG] File size: ${jsonContent.length} bytes`)

      // Verify file was written
      if (fs.existsSync(adgFilePath)) {
        logger.info(`[LangGraph ADG] File exists at ${adgFilePath}`)
      } else {
        logger.error(`[LangGraph ADG] File was not created at ${adgFilePath}`)
      }

      // Also log summary to console
      printf(`\n[LangGraph ADG Analysis Summary]`)
      printf(`  Graphs: ${output.summary.totalGraphs}`)
      printf(`  Agents: ${output.summary.totalAgents}`)
      printf(`  Tools: ${output.summary.totalTools}`)
      printf(`  LLMs: ${output.summary.totalLLMs}`)
      printf(`  Output: ${adgFilePath}\n`)
    } catch (error: any) {
      logger.error(`[LangGraph ADG] Error writing output: ${error.message}`)
      logger.error(`[LangGraph ADG] Error stack: ${error.stack}`)
      printf(`\n[LangGraph ADG] ERROR: Failed to write output file: ${error.message}\n`)
    }
  }
}

module.exports = LangGraphADGOutputStrategy

