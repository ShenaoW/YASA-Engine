const path = require("path");
const fs = require("fs-extra");
const simpleGit = require("simple-git");
const git = simpleGit();
const logger = require("../src/util/logger")(__filename);

const CONFIG = {
  baseDir: "./benchmarks",
  repoUrl:
    "https://github.com/alipay/ant-application-security-testing-benchmark.git",
  branches: {
    python: "main-forYasaTest",
    go: "main_roll_0905",
    java: "main-forYasaTest",
    javascript: "main-forYasaTest",
  },
  langConf: {
    python: { langDir: "python", benchName: "sast-python3" },
    go: { langDir: "go", benchName: "sast-go" },
    java: { langDir: "java", benchName: "sast-java" },
    javascript: { langDir: "javascript", benchName: "sast-js" },
  },
};

/**
 *
 * @param gitRepoUrl
 * @param targetDir
 * @param branch
 */
async function cloneRepoWithBranch(gitRepoUrl, targetDir, branch) {
  const absoluteTargetDir = path.resolve(targetDir);
  try {
    await git.clone(
      gitRepoUrl,
      absoluteTargetDir,
      branch ? ["-b", branch] : []
    );
    logger.info(`Repo cloned: ${gitRepoUrl} to ${targetDir}`);
    return true;
  } catch (e) {
    logger.error(`Clone failed: ${gitRepoUrl} to ${targetDir} error: ${e}`);
    throw new Error(`Failed to clone branch ${branch}`);
  }
}

function getSelectedLanguages(allowedLanguages) {
  return process.argv[2]
    ? process.argv[2].split(",").filter((lang) => {
        if (!allowedLanguages.includes(lang)) {
          console.error(
            `[ERROR] Unsupported language: ${lang}. Allowed languages are: ${allowedLanguages.join(", ")}`
          );
          return false;
        }
        return true;
      })
    : allowedLanguages;
}

function prepareBranchToLang(selectedLanguages) {
  const branchToLangMap = new Map();

  for (const lang of selectedLanguages) {
    const langConf = CONFIG.langConf[lang];
    if (!langConf) {
      console.log(`[WARN] Unknown language: ${lang}`);
      continue;
    }
    const branch = CONFIG.branches[lang];
    if (!branch) {
      console.log(`[WARN] No branch configured for language: ${lang}`);
      continue;
    }
    if (!branchToLangMap.has(branch)) {
      branchToLangMap.set(branch, []);
    }
    branchToLangMap.get(branch).push({ lang, config: langConf });
  }

  return branchToLangMap;
}

function prepareTempRepoBaseDir() {
  const tempRepoBaseDir = path.resolve(__dirname, CONFIG.baseDir, "_tmprepos");
  if (fs.existsSync(tempRepoBaseDir)) {
    fs.rmSync(tempRepoBaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempRepoBaseDir, { recursive: true });
  return tempRepoBaseDir;
}

async function prepareEachBranch(branch, branchInfos, tempRepoBaseDir) {
  const tempBranchDir = path.join(tempRepoBaseDir, branch);
  if (fs.existsSync(tempBranchDir)) {
    fs.rmSync(tempBranchDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempBranchDir, { recursive: true });

  console.log(
    `[INFO] Cloning repo ${CONFIG.repoUrl} [branch: ${branch}] to ${tempBranchDir}`
  );
  const ok = await cloneRepoWithBranch(CONFIG.repoUrl, tempBranchDir, branch);
  if (!ok) {
    console.log(`[ERROR] Repo clone failed for branch: ${branch}`);
    return;
  }

  for (const { lang, config } of branchInfos) {
    prepareEachLanguage(lang, config, tempBranchDir);
  }

  fs.rmSync(tempBranchDir, { recursive: true, force: true });
}

function prepareEachLanguage(lang, config, tempBranchDir) {
  const srcSubDir = path.join(tempBranchDir, config.benchName);
  if (!fs.existsSync(srcSubDir)) {
    console.log(
      `[WARN] Benchmark directory ${config.benchName} missing in branch, skip ${lang}.`
    );
    return;
  }
  const targetDir = path.resolve(__dirname, CONFIG.baseDir, config.langDir);
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copySync(srcSubDir, targetDir);
  console.log(`[INFO] ${lang} benchmark prepared.`);
}

/**
 *
 */
async function prepareAllBench() {
  const allowedLanguages = Object.keys(CONFIG.langConf);
  const selectedLanguages = getSelectedLanguages(allowedLanguages);

  const branchToLangMap = prepareBranchToLang(selectedLanguages);
  if (branchToLangMap.size === 0) {
    console.log("[WARN] No valid languages to prepare benchmarks for.");
    return;
  }

  const tempRepoBaseDir = prepareTempRepoBaseDir();

  for (const [branch, branchInfos] of branchToLangMap.entries()) {
    await prepareEachBranch(branch, branchInfos, tempRepoBaseDir);
  }

  fs.rmSync(tempRepoBaseDir, { recursive: true, force: true });
}

prepareAllBench();
