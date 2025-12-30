/**
 * Utility functions for LangGraph ADG Checker
 * 
 * These are pure functions that don't depend on checker instance state.
 * They can be used independently for extracting and processing LangGraph-related information.
 */

const SourceLine = require('../../../engine/analyzer/common/source-line')
const logger = require('../../../util/logger')(__filename)

/**
 * Determine tool type based on tool name
 * Custom tools: names that start with file paths (/, ./, ../) or contain path separators
 * Predefined tools: all other tools (from langchain, langchain_community, etc.)
 */
export function determineToolType(toolName: string): "custom" | "predefined" {
  // Check if tool name looks like a file path
  // Custom tools often have paths like: "./tools/search", "/path/to/tool", "../utils/tool"
  if (toolName.startsWith("/") || 
      toolName.startsWith("./") || 
      toolName.startsWith("../") ||
      toolName.includes("/") ||
      toolName.includes("\\")) {
    return "custom";
  }
  
  // Predefined tools are typically simple names like "search", "calculator", etc.
  // or from langchain packages
  return "predefined";
}

/**
 * Extract code snippet from tool node
 * Supports both AST nodes and YASA symbol values
 * 
 * @param toolInfo - Tool node (AST node or YASA symbol value)
 * @param analyzer - Optional analyzer instance for accessing sourceCodeCache
 * @returns Code snippet string or null
 */
export function extractToolCodeSnippet(analyzer: any, toolInfo: any): string | null {
  if (!toolInfo) return null;

  // Try to extract location from various possible structures
  let loc = null;
  if (toolInfo.vtype === "symbol") {
    loc = toolInfo.loc;
  } else if (toolInfo.vtype === "fclos") {
    loc = toolInfo.fdef.loc;
  } else {
    logger.debug(`[LangGraph ADG] Unsupported tool type: ${toolInfo.type}`);
    return null;
  }

  const sourcefile = loc.sourcefile;
  const startLine = loc.start.line;
  const endLine = loc.end.line;

  // Use analyzer's sourceCodeCache to populate SourceLine.codeCache, then use getCodeByLocation
  if (analyzer && analyzer.sourceCodeCache) {
    const sourceCode = analyzer.sourceCodeCache[sourcefile];
    if (sourceCode) {
      // Store code in SourceLine.codeCache if not already stored
      // This ensures getCodeByLocation can work properly
      try {
        SourceLine.storeCode(sourcefile, sourceCode);
        logger.debug(`[LangGraph ADG] Stored code in SourceLine.codeCache for: ${sourcefile}`);
      } catch (error) {
        logger.debug(`[LangGraph ADG] Failed to store code in SourceLine: ${error}`);
      }

      // Now try to use getCodeByLocation (should work now that codeCache is populated)
      try {
        const codeSnippet = SourceLine.getCodeByLocation(loc);
        if (codeSnippet && codeSnippet.trim().length > 0) {
          logger.debug(`[LangGraph ADG] Extracted code snippet from SourceLine.getCodeByLocation: ${sourcefile}:${startLine}-${endLine}`);
          return codeSnippet;
        }
      } catch (error) {
        logger.debug(`[LangGraph ADG] Failed to extract from SourceLine.getCodeByLocation: ${error}`);
      }

      // Fallback: Direct extraction from sourceCodeCache
      const lines = sourceCode.split('\n');
      const startIdx = startLine - 1;
      const endIdx = endLine - 1;
      if (startIdx >= 0 && endIdx < lines.length && startIdx <= endIdx) {
        const snippet = lines.slice(startIdx, endIdx + 1).join('\n');
        logger.debug(`[LangGraph ADG] Extracted code snippet directly from sourceCodeCache: ${sourcefile}:${startLine}-${endLine}`);
        return snippet;
      }
    }
  }

  logger.debug(`[LangGraph ADG] Could not extract code snippet: sourcefile=${sourcefile}, startLine=${startLine}, endLine=${endLine}, hasAnalyzer=${!!analyzer}, hasSourceCodeCache=${!!(analyzer && analyzer.sourceCodeCache && analyzer.sourceCodeCache[sourcefile])}`);
  return null;
}

/**
 * Extract variable name from AST node or symbol value
 */
export function extractVariableName(node: any): string | null {
  if (!node) return null;

  // Symbol value: has sid
  if (node.sid) {
    return node.sid;
  }

  // AST Identifier/Name node
  if (node.type === "Identifier" || node.type === "Name") {
    return node.name || node.id?.name || null;
  }

  // Symbol value with name
  if (node.name) {
    return node.name;
  }

  // Try to get from id
  if (node.id && node.id.name) {
    return node.id.name;
  }

  // String literal
  if (typeof node === "string") {
    return node;
  }

  // Value with string value
  if (node.vtype === "const" && typeof node.value === "string") {
    return node.value;
  }

  return null;
}

/**
 * Extract string value from symbol value or AST node
 */
export function extractStringValue(symVal: any): string | null {
  if (!symVal) return null;

  if (typeof symVal === "string") {
    return symVal;
  }

  // String literal AST node
  if (symVal.type === "StringLiteral" || symVal.type === "Str") {
    return symVal.value || symVal.s || null;
  }

  // Symbol value with const string
  if (symVal.vtype === "const" && typeof symVal.value === "string") {
    return symVal.value;
  }

  // Try to get from raw_value
  if (symVal.raw_value && typeof symVal.raw_value === "string") {
    return symVal.raw_value;
  }

  return null;
}

/**
 * Extract node name (handles START, END, string literals, Identifier, symbol values)
 */
export function extractNodeName(symVal: any): string | null {
  if (!symVal) return null;

  // String literal
  const strVal = extractStringValue(symVal);
  if (strVal) return strVal;

  // Symbol value: has sid
  if (symVal.sid) {
    return symVal.sid;
  }

  // Identifier (START, END constants)
  if (symVal.name) {
    return symVal.name;
  }

  // AST Identifier/Name node
  if (symVal.type === "Identifier" || symVal.type === "Name") {
    return symVal.name || symVal.id?.name || null;
  }

  // Try to get from id
  if (symVal.id && symVal.id.name) {
    return symVal.id.name;
  }

  return null;
}

/**
 * Compute value from YASA symbol value
 * Handles various vtypes: symbol, object, union, primitive, fclos, etc.
 * 
 * @param symVal - Symbol value from YASA's pointer analysis
 * @returns For collections: array of identifiers; For single values: string identifier, string content, or null
 */
export function computeValue(symVal: any): any {
  if (!symVal) return null;

  const vtype = symVal.vtype;
  if (!vtype) {
    // No vtype, try to get qid as fallback
    return symVal.qid || null;
  }

  // symbol: For BinaryExpression, compute left and right values and return the result;
  // For other types, set qid directly for Identifier;
  // SymbolValue extends ObjectValue, represents variable references
  if (vtype === "symbol" || vtype === "fclos") {
    if(symVal.type === "BinaryExpression") {
      const left = computeValue(symVal.left);
      const right = computeValue(symVal.right);
      return `${left}${symVal.operator}${right}`;
    } else {
      return symVal.qid;
    }
  }

  // object: Compute each Value in field
  // ObjectValue: field contains properties (dict), not array
  if (vtype === "object") {
    // For object type, field is a dict of properties
    // We need to compute each Value in field
    if (symVal.field && typeof symVal.field === "object" && !Array.isArray(symVal.field)) {
      // field is a dict, extract all values
      const identifiers: string[] = [];
      for (const key in symVal.field) {
        if (Object.prototype.hasOwnProperty.call(symVal.field, key)) {
          const fieldValue = symVal.field[key];
          if (fieldValue && fieldValue.vtype) {
            // It's a YASA Value, compute it
            const id = computeValue(fieldValue);
            if (id) {
              if (Array.isArray(id)) {
                identifiers.push(...id);
              } else {
                identifiers.push(id);
              }
            }
          }
        }
      }
      return identifiers.length > 0 ? identifiers : null;
    }
  }

  // union: field is an array of possible values
  if (vtype === "union") {
    if (symVal.field && Array.isArray(symVal.field)) {
      const identifiers: string[] = [];
      for (const elem of symVal.field) {
        if (elem && elem.vtype) {
          const id = computeValue(elem);
          if (id) {
            if (Array.isArray(id)) {
              identifiers.push(...id);
            } else {
              identifiers.push(id);
            }
          }
        }
      }
      return identifiers.length > 0 ? identifiers : null;
    }
  }

  // primitive / const: extract raw_value or value
  if (vtype === "primitive" || vtype === "const") {
    return symVal.raw_value || symVal.value || null;
  }

  // scope / package: extract qid or name
  if (vtype === "scope" || vtype === "package") {
    return symVal.qid || symVal.name || null;
  }

  // BVT (Bound Value Type): compute children
  if (vtype === "BVT") {
    if (symVal.children && Array.isArray(symVal.children)) {
      const identifiers: string[] = [];
      for (const child of symVal.children) {
        const id = computeValue(child);
        if (id) {
          if (Array.isArray(id)) {
            identifiers.push(...id);
          } else {
            identifiers.push(id);
          }
        }
      }
      return identifiers.length > 0 ? identifiers : null;
    }
  }

  // list: if it exists as a separate type
  if (vtype === "list") {
    if (symVal.field && Array.isArray(symVal.field)) {
      const identifiers: string[] = [];
      for (const elem of symVal.field) {
        const id = computeValue(elem);
        if (id) {
          if (Array.isArray(id)) {
            identifiers.push(...id);
          } else {
            identifiers.push(id);
          }
        }
      }
      return identifiers.length > 0 ? identifiers : null;
    }
    if (symVal.value && Array.isArray(symVal.value)) {
      const identifiers: string[] = [];
      for (const elem of symVal.value) {
        const id = computeValue(elem);
        if (id) {
          if (Array.isArray(id)) {
            identifiers.push(...id);
          } else {
            identifiers.push(id);
          }
        }
      }
      return identifiers.length > 0 ? identifiers : null;
    }
  }

  // unknown, undefine, uninitialized: return null
  if (vtype === "unknown" || vtype === "undefine" || vtype === "uninitialized") {
    return null;
  }

  // Fallback: try to get qid
  return symVal.qid || null;
}

/**
 * Check if a symbol value is a StateGraph instance
 */
export function isStateGraphInstance(symVal: any): boolean {
  if (symVal.type === "CallExpression" && symVal.callee.type === "Identifier") {
    return symVal.callee.name.includes("StateGraph");
  } else {
    return false;
  }
}

/**
 * Check if a function name is an agent creation method
 */
export function isAgentCreationMethod(funcName: string): boolean {
  const agentCreationMethods = [
    "create_agent",
    "create_react_agent",
    "create_tool_calling_agent"
  ];
  for (const method of agentCreationMethods) {
    if (funcName.endsWith(method)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  determineToolType,
  extractToolCodeSnippet,
  extractVariableName,
  extractStringValue,
  extractNodeName,
  computeValue,
  isStateGraphInstance,
  isAgentCreationMethod,
};

