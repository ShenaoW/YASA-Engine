const pathMod = require('path')
const fs = require('fs-extra')
const OutputStrategy = require('../../../engine/analyzer/common/output-strategy')
const logger = require('../../../util/logger')(__filename)

/**
 * Output strategy for LangGraph Agent Dependency Graph (JSON format)
 * Outputs ADG in JSON format compatible with the ADG visualization tools
 */
class LangGraphADGJSONOutputStrategy extends OutputStrategy {
  static outputStrategyId = 'langgraph_adg_json'

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
      logger.warn('[LangGraph ADG JSON] No findings to output')
      return
    }

    logger.debug(`[LangGraph ADG JSON] All findings keys: ${Object.keys(allFindings).join(', ')}`)

    const findings = allFindings['langgraph_adg'] || allFindings[LangGraphADGJSONOutputStrategy.outputStrategyId]

    if (!findings || findings.length === 0) {
      logger.warn(`[LangGraph ADG JSON] No LangGraph ADG findings generated. Available keys: ${Object.keys(allFindings).join(', ')}`)
      return
    }

    logger.info(`[LangGraph ADG JSON] Found ${findings.length} finding(s)`)

    if (!config.reportDir) {
      logger.warn('[LangGraph ADG JSON] No report directory specified')
      return
    }

    try {
      const finding = findings[0] // Should be a single finding with all graphs
      const adgFilePath = pathMod.join(config.reportDir, outputFilePath)

      logger.info(`[LangGraph ADG JSON] Writing ADG to ${adgFilePath}`)

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

      logger.info(`[LangGraph ADG JSON] Output data: ${JSON.stringify({
        graphs: output.summary.totalGraphs,
        agents: output.summary.totalAgents,
        tools: output.summary.totalTools,
        llms: output.summary.totalLLMs,
      })}`)

      // Write to file with pretty printing
      const jsonContent = JSON.stringify(output, null, 2)
      fs.writeFileSync(adgFilePath, jsonContent, 'utf8')

      logger.info(`[LangGraph ADG JSON] Successfully wrote ADG to ${adgFilePath}`)
      logger.info(`[LangGraph ADG JSON] File size: ${jsonContent.length} bytes`)

      // Verify file was written
      if (fs.existsSync(adgFilePath)) {
        logger.info(`[LangGraph ADG JSON] File exists at ${adgFilePath}`)
      } else {
        logger.error(`[LangGraph ADG JSON] File was not created at ${adgFilePath}`)
      }

      // Also log summary to console
      printf(`\n[LangGraph ADG JSON Analysis Summary]`)
      printf(`  Graphs: ${output.summary.totalGraphs}`)
      printf(`  Agents: ${output.summary.totalAgents}`)
      printf(`  Tools: ${output.summary.totalTools}`)
      printf(`  LLMs: ${output.summary.totalLLMs}`)
      printf(`  Output: ${adgFilePath}\n`)
    } catch (error: any) {
      logger.error(`[LangGraph ADG JSON] Error writing output: ${error.message}`)
      logger.error(`[LangGraph ADG JSON] Error stack: ${error.stack}`)
      printf(`\n[LangGraph ADG JSON] ERROR: Failed to write output file: ${error.message}\n`)
    }
  }
}

module.exports = LangGraphADGJSONOutputStrategy

