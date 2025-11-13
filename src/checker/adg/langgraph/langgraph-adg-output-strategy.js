const pathMod = require("path");
const fs = require("fs-extra");
const OutputStrategy = require("../../../engine/analyzer/common/output-strategy");
const logger = require("../../../util/logger")(__filename);

/**
 * Output strategy for LangGraph Agent Dependency Graph
 * Outputs ADG in JSON format compatible with the ADG visualization tools
 */
class LangGraphADGOutputStrategy extends OutputStrategy {
  /**
   * Constructor
   */
  constructor() {
    super();
    this.outputFilePath = "langgraph-adg.json";
  }

  /**
   * Output LangGraph ADG findings to JSON file
   *
   * @param {ResultManager} resultManager
   * @param {string} outputFilePath
   * @param {object} config
   * @param {function} printf
   */
  outputFindings(resultManager, outputFilePath, config, printf) {
    const allFindings = resultManager.getFindings();

    if (!allFindings) {
      logger.warn("[LangGraph ADG] No findings to output");
      return;
    }

    const findings = allFindings[LangGraphADGOutputStrategy.outputStrategyId];

    if (!findings || findings.length === 0) {
      logger.warn("[LangGraph ADG] No LangGraph ADG findings generated");
      return;
    }

    if (!config.reportDir) {
      logger.warn("[LangGraph ADG] No report directory specified");
      return;
    }

    try {
      const finding = findings[0]; // Should be a single finding with all graphs
      const adgFilePath = pathMod.join(config.reportDir, outputFilePath);

      logger.info(`[LangGraph ADG] Writing ADG to ${adgFilePath}`);

      // Format the output for better readability
      const output = {
        framework: "langgraph",
        version: "1.0.0",
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
      };

      // Write to file with pretty printing
      const jsonContent = JSON.stringify(output, null, 2);
      fs.writeFileSync(adgFilePath, jsonContent, "utf8");

      logger.info(`[LangGraph ADG] Successfully wrote ADG to ${adgFilePath}`);

      // Also log summary to console
      printf(`\n[LangGraph ADG Analysis Summary]`);
      printf(`  Graphs: ${output.summary.totalGraphs}`);
      printf(`  Agents: ${output.summary.totalAgents}`);
      printf(`  Tools: ${output.summary.totalTools}`);
      printf(`  LLMs: ${output.summary.totalLLMs}`);
      printf(`  Output: ${adgFilePath}\n`);
    } catch (error) {
      logger.error(`[LangGraph ADG] Error writing output: ${error.message}`);
      logger.error(error.stack);
    }
  }
}

LangGraphADGOutputStrategy.outputStrategyId = "langgraph_adg";

module.exports = LangGraphADGOutputStrategy;
