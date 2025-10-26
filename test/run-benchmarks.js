const _ = require("lodash");
const path = require("path");
const { describe, it } = require("mocha");
const fs = require("fs");
const assert = require("assert");
const { execute } = require("../src/interface/starter");
const logger = require("../src/util/logger")(__filename);
const {
  recordFindingStr,
  resolveTestFindingResult,
  readExpectRes,
} = require("./test-utils");
const {
  handleException,
} = require("../src/engine/analyzer/common/exception-handler");
const JSAnalyzer = require("../src/engine/analyzer/javascript/common/js-analyzer");
const GoAnalyzer = require("../src/engine/analyzer/golang/common/go-analyzer");
const config = require("../src/config.js");
const OutputStrategyAutoRegister = require("../src/engine/analyzer/common/output-strategy-auto-register");

const testConfigs = {
  python: {
    expectFilePath: path.join(__dirname, "expected/python-expected.result"),
    benchDir: path.resolve(__dirname, "benchmarks/python/"),
    language: "python",
    analyzer: "PythonAnalyzer",
    ruleConfigFile: path.join(__dirname, "rules/rule_config_xast_python.json"),
    checkerIds: "taint_flow_test",
    checkerPackIds: null,
    uastSDKPath: path.join(__dirname, "../deps/uast4py/uast4py"),
  },
  javascript: {
    expectFilePath: path.join(__dirname, "expected/javascript-expected.json"),
    language: "javascript",
    benchDir: path.resolve(__dirname, "benchmarks/javascript/"),
    analyzer: "JavaScriptAnalyzer",
    ruleConfigFile: path.join(__dirname, "rules/rule_config_xast_js.json"),
    checkerIds: "taint_flow_test",
    checkerPackIds: null,
    uastSDKPath: null,
  },
  java: {
    expectFilePath: path.join(__dirname, "expected/java-expected.result"),
    benchDir: path.resolve(__dirname, "benchmarks/java/"),
    language: "java",
    analyzer: "SpringAnalyzer",
    ruleConfigFile: path.join(__dirname, "rules/rule_config_xast_java.json"),
    checkerIds: null,
    checkerPackIds: "taint-flow-java-inner",
    uastSDKPath: null,
  },
  golang: {
    expectFilePath: path.join(__dirname, "expected/go-expected.json"),
    benchDir: path.resolve(__dirname, "benchmarks/go/"),
    language: "golang",
    analyzer: "GoAnalyzer",
    ruleConfigFile: path.join(__dirname, "rules/rule_config_xast_go.json"),
    checkerIds: "taint_flow_test",
    checkerPackIds: null,
    uastSDKPath: path.join(__dirname, "../deps/uast4go/uast4go"),
  },
};

function prepareArgs(config) {
  const args = [config.benchDir];
  if (config.language) args.push("--language", config.language);
  if (config.analyzer) args.push("--analyzer", config.analyzer);
  if (config.ruleConfigFile)
    args.push("--ruleConfigFile", config.ruleConfigFile);
  if (config.checkerIds) args.push("--checkerIds", config.checkerIds);
  if (config.checkerPackIds)
    args.push("--checkerPackIds", config.checkerPackIds);
  if (config.uastSDKPath) args.push("--uastSDKPath", config.uastSDKPath);
  return args;
}

async function runBenchmark(lang) {
  const config = testConfigs[lang.toLowerCase()];
  if (!config) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  const expectFilePath = config.expectFilePath;
  const recorder = recordFindingStr();
  recorder.clearResult();

  const args = prepareArgs(config);
  const actualRes = await runAllTests(lang, args, recorder);

  const expectedRes = readExpectRes(expectFilePath);
  const expectedResMap = resolveTestFindingResult(expectedRes);
  const actualResMap = resolveTestFindingResult(actualRes);

  compareResults(expectedRes, actualRes, expectedResMap, actualResMap, lang);
  logger.info(`${lang} benchmark passed.`);
}

function compareResults(
  expectedRes,
  actualRes,
  expectedResMap,
  actualResMap,
  lang
) {
  const description = `${lang} benchmark results comparison`;
  describe(description, async function () {
    it(`check result data directly`, async function () {
      logger.info(actualRes);
      assert.strictEqual(
        actualRes,
        expectedRes,
        `${lang} benchmark results do not match expected results.`
      );
    });

    let i = 1;
    for (const [key, value] of expectedResMap.entries()) {
      it(`${i++}-file:${key}`, function () {
        if (lang === "java") {
          if (actualResMap.has(key)) {
            assert.strictEqual(
              actualResMap.get(key),
              value,
              `链路${key}实际trace或内容与预期不一致，请核对该链路`
            );
          } else {
            assert.fail(`链路或key${key}不存在！！！`);
          }
        } else if (lang === "python") {
          if (Array.isArray(value)) {
            logger.info("expected:\n");
            value.forEach((chain) => logger.info(`${chain}\n`));
          } else {
            logger.info(`expected:\n${value}`);
          }
          if (Array.isArray(actualResMap.get(key))) {
            logger.info("actual:\n");
            actualResMap.get(key).forEach((chain) => logger.info(`${chain}\n`));
          } else {
            logger.info(`actual:\n${actualResMap.get(key)}`);
          }

          if (actualResMap.has(key)) {
            if (
              Array.isArray(value) &&
              Array.isArray(actualResMap.get(key)) &&
              value.length === actualResMap.get(key).length
            ) {
              for (const i in value) {
                assert.strictEqual(
                  actualResMap.get(key)[i],
                  value[i],
                  `Trace ${key} actual content does not match expected.`
                );
              }
            } else {
              assert.strictEqual(
                actualResMap.get(key),
                value,
                `Trace ${key} actual content does not match expected.`
              );
            }
          } else {
            assert.fail(`Trace or key ${key} does not exist!`);
          }
        }
      });
    }

    const actualChains = Array.from(actualResMap.keys());
    const addChains = actualChains.filter((key) => !expectedResMap.has(key));
    if (Array.isArray(addChains) && addChains.length > 0) {
      for (const addChain of addChains) {
        it(`new chain:${addChain}`, function () {
          logger.info(
            `New detection ${addChain}, please verify if it meets expectations.`
          );
          logger.info(actualResMap.get(addChain));
          assert.fail(`new chain:${addChain}`);
        });
      }
    }
  });
}

async function updateExpectedRes(lang) {
  const config = testConfigs[lang.toLowerCase()];
  if (!config) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  const expectFilePath = config.expectFilePath;
  const recorder = recordFindingStr();
  recorder.clearResult();

  const args = prepareArgs(config);
  const actualRes = await runAllTests(lang, args, recorder);
  fs.writeFileSync(expectFilePath, actualRes, {
    encoding: "utf8",
  });
}

async function runAllTests(lang, args, recorder) {
  // TODO: For JS/Go, run each test seperately (output JSON); For Java/Python, run all tests together (output string)
  if (lang === "javascript" || lang === "golang") {
    const allCases = getAllTestCase(lang);
    const actualRes = {};
    const actualResMap = new Map();
    const outputStrategyAutoRegister = new OutputStrategyAutoRegister();
    outputStrategyAutoRegister.autoRegisterAllStrategies();
    for (const casePath of allCases) {
      const singleRes = runSingleTest(
        casePath,
        actualResMap,
        lang,
        outputStrategyAutoRegister
      );
      if (singleRes) {
        for (const [key, value] of Object.entries(singleRes)) {
          actualRes[key] = value;
        }
      }
    }
    return JSON.stringify(actualRes);
  } else if (lang === "java" || lang === "python") {
    try {
      await execute(null, args, recorder.printAndAppend);
    } catch (e) {
      handleException(
        e,
        `Error occurred while updating ${lang} benchmark expected results: ${e}`
      );
      recorder.clearResult();
      process.exitCode = ErrorCode.unknown_error;
    }
    const actualRes = recorder.getFormatResult();
    return actualRes;
  }
}

function getAllTestCase(lang) {
  const ALL_TEST_CASE = [];

  const filename = testConfigs[lang].benchDir;

  function loadTestCase(filename) {
    let fileStat;
    try {
      fileStat = fs.lstatSync(filename);
    } catch (e) {
      handleException(
        e,
        `Error occurred in test-${lang}-benchmark.loadTestCase`
      );
    }
    if (!fileStat) return;
    if (fileStat.isDirectory()) {
      const dir = filename;
      const files = fs.readdirSync(dir);
      for (const i in files) {
        const name = path.join(dir, files[i]);
        loadTestCase(name);
      }
    } else {
      if (!filename.endsWith(".go") && !filename.endsWith(".js")) return;
      ALL_TEST_CASE.push(filename);
    }
  }

  loadTestCase(filename);
  return ALL_TEST_CASE;
}

function runSingleTest(
  casePath,
  actualResMap,
  lang,
  outputStrategyAutoRegister
) {
  // Only for JavaScript and Go
  config.ruleConfigFile = testConfigs[lang].ruleConfigFile;
  config.checkerIds = [testConfigs[lang].checkerIds];
  if (testConfigs[lang].uastSDKPath) {
    config.uastSDKPath = testConfigs[lang].uastSDKPath;
  }
  config.language = lang === "javascript" ? "javascript" : "golang";

  const code = fs.readFileSync(casePath).toString();
  const recorder = recordFindingStr();
  let filename;
  let analyzer;
  if (lang === "javascript") {
    filename = casePath
      .substring(casePath.lastIndexOf("/benchmarks"))
      .replaceAll(".js", "");
    analyzer = new JSAnalyzer({
      ...config,
      language: "javascript",
      checkers: {
        taint_flow_test: true,
      },
      mode: { intra: true },
      sanity: true,
    });
  } else if (lang === "golang") {
    filename = casePath
      .substring(casePath.lastIndexOf("/benchmarks"))
      .replaceAll(".go", "");
    analyzer = new GoAnalyzer({
      language: "golang",
      examineIssues: true,
      checkers: {
        taint_flow_test: true,
      },
      ...config,
      mode: { intra: true },
      sanity: true,
    });
  }
  const findingRes = analyzer.analyzeSingleFile(code, casePath);
  if (findingRes) {
    const { resultManager } = analyzer.getCheckerManager();
    const allFindings = resultManager.getFindings();
    if (_.isEmpty(allFindings)) {
      recorder.printAndAppend(
        "\n======================== Findings ======================== "
      );
      recorder.printAndAppend("No findings!");
      recorder.printAndAppend(
        "========================================================== \n"
      );
    }
    for (const outputStrategyId in allFindings) {
      const strategy = outputStrategyAutoRegister.getStrategy(outputStrategyId);
      if (strategy && typeof strategy.outputFindings === "function") {
        strategy.outputFindings(
          resultManager,
          strategy.getOutputFilePath(),
          config,
          recorder.printAndAppend
        );
      }
    }
    recordFinding(findingRes, filename, actualResMap);
    return { [filename]: recorder.getFormatResult() };
  }
}

function recordFinding(finding, filename, findingResMap) {
  const keyname = filename.substring(filename.lastIndexOf("/benchmarks"));
  for (const ruleName of ["taint_flow_test"]) {
    if (!finding || Object.keys(finding).length === 0) {
      findingResMap.set(keyname, { [ruleName]: 0 });
      continue;
    }
    if (finding[ruleName]) {
      findingResMap.set(keyname, { [ruleName]: finding[ruleName].length });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  let updateExpected = false;
  let langs = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--update" && i + 1 < args.length) {
      updateExpected = args[i + 1];
    } else if (args[i] === "--language" && i + 1 < args.length) {
      langs = args[i + 1].toLowerCase();
      i++;
    }
  }

  const langList = langs ? langs.split(",") : Object.keys(testConfigs);

  for (const lang of langList) {
    if (!fs.existsSync(testConfigs[lang].benchDir)) {
      console.error(`Benchmark directory does not exist for ${lang}`);
      continue;
    }
    if (updateExpected) {
      console.log(`Updating expected results for ${lang}...`);
      try {
        await updateExpectedRes(lang);
      } catch (error) {
        logger.error(`Error updating ${lang} expected results:`, error);
      }
      console.log(`Expected results for ${lang} updated.`);
    } else {
      try {
        await runBenchmark(lang);
      } catch (error) {
        logger.error(`Error running ${lang} benchmarks:`, error);
      }
    }
  }
}

main();
