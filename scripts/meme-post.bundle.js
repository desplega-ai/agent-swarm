#!/usr/bin/env bun
// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;

// node_modules/commander/lib/error.js
var require_error = __commonJS((exports) => {
  class CommanderError extends Error {
    constructor(exitCode, code, message) {
      super(message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
      this.code = code;
      this.exitCode = exitCode;
      this.nestedError = undefined;
    }
  }

  class InvalidArgumentError extends CommanderError {
    constructor(message) {
      super(1, "commander.invalidArgument", message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
    }
  }
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
});

// node_modules/commander/lib/argument.js
var require_argument = __commonJS((exports) => {
  var { InvalidArgumentError } = require_error();

  class Argument {
    constructor(name, description) {
      this.description = description || "";
      this.variadic = false;
      this.parseArg = undefined;
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.argChoices = undefined;
      switch (name[0]) {
        case "<":
          this.required = true;
          this._name = name.slice(1, -1);
          break;
        case "[":
          this.required = false;
          this._name = name.slice(1, -1);
          break;
        default:
          this.required = true;
          this._name = name;
          break;
      }
      if (this._name.length > 3 && this._name.slice(-3) === "...") {
        this.variadic = true;
        this._name = this._name.slice(0, -3);
      }
    }
    name() {
      return this._name;
    }
    _concatValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      return previous.concat(value);
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
        }
        if (this.variadic) {
          return this._concatValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    argRequired() {
      this.required = true;
      return this;
    }
    argOptional() {
      this.required = false;
      return this;
    }
  }
  function humanReadableArgName(arg) {
    const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
    return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
  }
  exports.Argument = Argument;
  exports.humanReadableArgName = humanReadableArgName;
});

// node_modules/commander/lib/help.js
var require_help = __commonJS((exports) => {
  var { humanReadableArgName } = require_argument();

  class Help {
    constructor() {
      this.helpWidth = undefined;
      this.sortSubcommands = false;
      this.sortOptions = false;
      this.showGlobalOptions = false;
    }
    visibleCommands(cmd) {
      const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
      const helpCommand = cmd._getHelpCommand();
      if (helpCommand && !helpCommand._hidden) {
        visibleCommands.push(helpCommand);
      }
      if (this.sortSubcommands) {
        visibleCommands.sort((a, b) => {
          return a.name().localeCompare(b.name());
        });
      }
      return visibleCommands;
    }
    compareOptions(a, b) {
      const getSortKey = (option) => {
        return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
      };
      return getSortKey(a).localeCompare(getSortKey(b));
    }
    visibleOptions(cmd) {
      const visibleOptions = cmd.options.filter((option) => !option.hidden);
      const helpOption = cmd._getHelpOption();
      if (helpOption && !helpOption.hidden) {
        const removeShort = helpOption.short && cmd._findOption(helpOption.short);
        const removeLong = helpOption.long && cmd._findOption(helpOption.long);
        if (!removeShort && !removeLong) {
          visibleOptions.push(helpOption);
        } else if (helpOption.long && !removeLong) {
          visibleOptions.push(cmd.createOption(helpOption.long, helpOption.description));
        } else if (helpOption.short && !removeShort) {
          visibleOptions.push(cmd.createOption(helpOption.short, helpOption.description));
        }
      }
      if (this.sortOptions) {
        visibleOptions.sort(this.compareOptions);
      }
      return visibleOptions;
    }
    visibleGlobalOptions(cmd) {
      if (!this.showGlobalOptions)
        return [];
      const globalOptions = [];
      for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        const visibleOptions = ancestorCmd.options.filter((option) => !option.hidden);
        globalOptions.push(...visibleOptions);
      }
      if (this.sortOptions) {
        globalOptions.sort(this.compareOptions);
      }
      return globalOptions;
    }
    visibleArguments(cmd) {
      if (cmd._argsDescription) {
        cmd.registeredArguments.forEach((argument) => {
          argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
        });
      }
      if (cmd.registeredArguments.find((argument) => argument.description)) {
        return cmd.registeredArguments;
      }
      return [];
    }
    subcommandTerm(cmd) {
      const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
      return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + (args ? " " + args : "");
    }
    optionTerm(option) {
      return option.flags;
    }
    argumentTerm(argument) {
      return argument.name();
    }
    longestSubcommandTermLength(cmd, helper) {
      return helper.visibleCommands(cmd).reduce((max, command) => {
        return Math.max(max, helper.subcommandTerm(command).length);
      }, 0);
    }
    longestOptionTermLength(cmd, helper) {
      return helper.visibleOptions(cmd).reduce((max, option) => {
        return Math.max(max, helper.optionTerm(option).length);
      }, 0);
    }
    longestGlobalOptionTermLength(cmd, helper) {
      return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
        return Math.max(max, helper.optionTerm(option).length);
      }, 0);
    }
    longestArgumentTermLength(cmd, helper) {
      return helper.visibleArguments(cmd).reduce((max, argument) => {
        return Math.max(max, helper.argumentTerm(argument).length);
      }, 0);
    }
    commandUsage(cmd) {
      let cmdName = cmd._name;
      if (cmd._aliases[0]) {
        cmdName = cmdName + "|" + cmd._aliases[0];
      }
      let ancestorCmdNames = "";
      for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
      }
      return ancestorCmdNames + cmdName + " " + cmd.usage();
    }
    commandDescription(cmd) {
      return cmd.description();
    }
    subcommandDescription(cmd) {
      return cmd.summary() || cmd.description();
    }
    optionDescription(option) {
      const extraInfo = [];
      if (option.argChoices) {
        extraInfo.push(`choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
      }
      if (option.defaultValue !== undefined) {
        const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
        if (showDefault) {
          extraInfo.push(`default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`);
        }
      }
      if (option.presetArg !== undefined && option.optional) {
        extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
      }
      if (option.envVar !== undefined) {
        extraInfo.push(`env: ${option.envVar}`);
      }
      if (extraInfo.length > 0) {
        return `${option.description} (${extraInfo.join(", ")})`;
      }
      return option.description;
    }
    argumentDescription(argument) {
      const extraInfo = [];
      if (argument.argChoices) {
        extraInfo.push(`choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
      }
      if (argument.defaultValue !== undefined) {
        extraInfo.push(`default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`);
      }
      if (extraInfo.length > 0) {
        const extraDescripton = `(${extraInfo.join(", ")})`;
        if (argument.description) {
          return `${argument.description} ${extraDescripton}`;
        }
        return extraDescripton;
      }
      return argument.description;
    }
    formatHelp(cmd, helper) {
      const termWidth = helper.padWidth(cmd, helper);
      const helpWidth = helper.helpWidth || 80;
      const itemIndentWidth = 2;
      const itemSeparatorWidth = 2;
      function formatItem(term, description) {
        if (description) {
          const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
          return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
        }
        return term;
      }
      function formatList(textArray) {
        return textArray.join(`
`).replace(/^/gm, " ".repeat(itemIndentWidth));
      }
      let output = [`Usage: ${helper.commandUsage(cmd)}`, ""];
      const commandDescription = helper.commandDescription(cmd);
      if (commandDescription.length > 0) {
        output = output.concat([
          helper.wrap(commandDescription, helpWidth, 0),
          ""
        ]);
      }
      const argumentList = helper.visibleArguments(cmd).map((argument) => {
        return formatItem(helper.argumentTerm(argument), helper.argumentDescription(argument));
      });
      if (argumentList.length > 0) {
        output = output.concat(["Arguments:", formatList(argumentList), ""]);
      }
      const optionList = helper.visibleOptions(cmd).map((option) => {
        return formatItem(helper.optionTerm(option), helper.optionDescription(option));
      });
      if (optionList.length > 0) {
        output = output.concat(["Options:", formatList(optionList), ""]);
      }
      if (this.showGlobalOptions) {
        const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
          return formatItem(helper.optionTerm(option), helper.optionDescription(option));
        });
        if (globalOptionList.length > 0) {
          output = output.concat([
            "Global Options:",
            formatList(globalOptionList),
            ""
          ]);
        }
      }
      const commandList = helper.visibleCommands(cmd).map((cmd2) => {
        return formatItem(helper.subcommandTerm(cmd2), helper.subcommandDescription(cmd2));
      });
      if (commandList.length > 0) {
        output = output.concat(["Commands:", formatList(commandList), ""]);
      }
      return output.join(`
`);
    }
    padWidth(cmd, helper) {
      return Math.max(helper.longestOptionTermLength(cmd, helper), helper.longestGlobalOptionTermLength(cmd, helper), helper.longestSubcommandTermLength(cmd, helper), helper.longestArgumentTermLength(cmd, helper));
    }
    wrap(str, width, indent, minColumnWidth = 40) {
      const indents = " \\f\\t\\v\xA0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF";
      const manualIndent = new RegExp(`[\\n][${indents}]+`);
      if (str.match(manualIndent))
        return str;
      const columnWidth = width - indent;
      if (columnWidth < minColumnWidth)
        return str;
      const leadingStr = str.slice(0, indent);
      const columnText = str.slice(indent).replace(`\r
`, `
`);
      const indentString = " ".repeat(indent);
      const zeroWidthSpace = "\u200B";
      const breaks = `\\s${zeroWidthSpace}`;
      const regex = new RegExp(`
|.{1,${columnWidth - 1}}([${breaks}]|$)|[^${breaks}]+?([${breaks}]|$)`, "g");
      const lines = columnText.match(regex) || [];
      return leadingStr + lines.map((line, i) => {
        if (line === `
`)
          return "";
        return (i > 0 ? indentString : "") + line.trimEnd();
      }).join(`
`);
    }
  }
  exports.Help = Help;
});

// node_modules/commander/lib/option.js
var require_option = __commonJS((exports) => {
  var { InvalidArgumentError } = require_error();

  class Option {
    constructor(flags, description) {
      this.flags = flags;
      this.description = description || "";
      this.required = flags.includes("<");
      this.optional = flags.includes("[");
      this.variadic = /\w\.\.\.[>\]]$/.test(flags);
      this.mandatory = false;
      const optionFlags = splitOptionFlags(flags);
      this.short = optionFlags.shortFlag;
      this.long = optionFlags.longFlag;
      this.negate = false;
      if (this.long) {
        this.negate = this.long.startsWith("--no-");
      }
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.presetArg = undefined;
      this.envVar = undefined;
      this.parseArg = undefined;
      this.hidden = false;
      this.argChoices = undefined;
      this.conflictsWith = [];
      this.implied = undefined;
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    preset(arg) {
      this.presetArg = arg;
      return this;
    }
    conflicts(names) {
      this.conflictsWith = this.conflictsWith.concat(names);
      return this;
    }
    implies(impliedOptionValues) {
      let newImplied = impliedOptionValues;
      if (typeof impliedOptionValues === "string") {
        newImplied = { [impliedOptionValues]: true };
      }
      this.implied = Object.assign(this.implied || {}, newImplied);
      return this;
    }
    env(name) {
      this.envVar = name;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    makeOptionMandatory(mandatory = true) {
      this.mandatory = !!mandatory;
      return this;
    }
    hideHelp(hide = true) {
      this.hidden = !!hide;
      return this;
    }
    _concatValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      return previous.concat(value);
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
        }
        if (this.variadic) {
          return this._concatValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    name() {
      if (this.long) {
        return this.long.replace(/^--/, "");
      }
      return this.short.replace(/^-/, "");
    }
    attributeName() {
      return camelcase(this.name().replace(/^no-/, ""));
    }
    is(arg) {
      return this.short === arg || this.long === arg;
    }
    isBoolean() {
      return !this.required && !this.optional && !this.negate;
    }
  }

  class DualOptions {
    constructor(options) {
      this.positiveOptions = new Map;
      this.negativeOptions = new Map;
      this.dualOptions = new Set;
      options.forEach((option) => {
        if (option.negate) {
          this.negativeOptions.set(option.attributeName(), option);
        } else {
          this.positiveOptions.set(option.attributeName(), option);
        }
      });
      this.negativeOptions.forEach((value, key) => {
        if (this.positiveOptions.has(key)) {
          this.dualOptions.add(key);
        }
      });
    }
    valueFromOption(value, option) {
      const optionKey = option.attributeName();
      if (!this.dualOptions.has(optionKey))
        return true;
      const preset = this.negativeOptions.get(optionKey).presetArg;
      const negativeValue = preset !== undefined ? preset : false;
      return option.negate === (negativeValue === value);
    }
  }
  function camelcase(str) {
    return str.split("-").reduce((str2, word) => {
      return str2 + word[0].toUpperCase() + word.slice(1);
    });
  }
  function splitOptionFlags(flags) {
    let shortFlag;
    let longFlag;
    const flagParts = flags.split(/[ |,]+/);
    if (flagParts.length > 1 && !/^[[<]/.test(flagParts[1]))
      shortFlag = flagParts.shift();
    longFlag = flagParts.shift();
    if (!shortFlag && /^-[^-]$/.test(longFlag)) {
      shortFlag = longFlag;
      longFlag = undefined;
    }
    return { shortFlag, longFlag };
  }
  exports.Option = Option;
  exports.DualOptions = DualOptions;
});

// node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS((exports) => {
  var maxDistance = 3;
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > maxDistance)
      return Math.max(a.length, b.length);
    const d = [];
    for (let i = 0;i <= a.length; i++) {
      d[i] = [i];
    }
    for (let j = 0;j <= b.length; j++) {
      d[0][j] = j;
    }
    for (let j = 1;j <= b.length; j++) {
      for (let i = 1;i <= a.length; i++) {
        let cost = 1;
        if (a[i - 1] === b[j - 1]) {
          cost = 0;
        } else {
          cost = 1;
        }
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }
  function suggestSimilar(word, candidates) {
    if (!candidates || candidates.length === 0)
      return "";
    candidates = Array.from(new Set(candidates));
    const searchingOptions = word.startsWith("--");
    if (searchingOptions) {
      word = word.slice(2);
      candidates = candidates.map((candidate) => candidate.slice(2));
    }
    let similar = [];
    let bestDistance = maxDistance;
    const minSimilarity = 0.4;
    candidates.forEach((candidate) => {
      if (candidate.length <= 1)
        return;
      const distance = editDistance(word, candidate);
      const length = Math.max(word.length, candidate.length);
      const similarity = (length - distance) / length;
      if (similarity > minSimilarity) {
        if (distance < bestDistance) {
          bestDistance = distance;
          similar = [candidate];
        } else if (distance === bestDistance) {
          similar.push(candidate);
        }
      }
    });
    similar.sort((a, b) => a.localeCompare(b));
    if (searchingOptions) {
      similar = similar.map((candidate) => `--${candidate}`);
    }
    if (similar.length > 1) {
      return `
(Did you mean one of ${similar.join(", ")}?)`;
    }
    if (similar.length === 1) {
      return `
(Did you mean ${similar[0]}?)`;
    }
    return "";
  }
  exports.suggestSimilar = suggestSimilar;
});

// node_modules/commander/lib/command.js
var require_command = __commonJS((exports) => {
  var EventEmitter = __require("events").EventEmitter;
  var childProcess = __require("child_process");
  var path = __require("path");
  var fs = __require("fs");
  var process2 = __require("process");
  var { Argument, humanReadableArgName } = require_argument();
  var { CommanderError } = require_error();
  var { Help } = require_help();
  var { Option, DualOptions } = require_option();
  var { suggestSimilar } = require_suggestSimilar();

  class Command extends EventEmitter {
    constructor(name) {
      super();
      this.commands = [];
      this.options = [];
      this.parent = null;
      this._allowUnknownOption = false;
      this._allowExcessArguments = true;
      this.registeredArguments = [];
      this._args = this.registeredArguments;
      this.args = [];
      this.rawArgs = [];
      this.processedArgs = [];
      this._scriptPath = null;
      this._name = name || "";
      this._optionValues = {};
      this._optionValueSources = {};
      this._storeOptionsAsProperties = false;
      this._actionHandler = null;
      this._executableHandler = false;
      this._executableFile = null;
      this._executableDir = null;
      this._defaultCommandName = null;
      this._exitCallback = null;
      this._aliases = [];
      this._combineFlagAndOptionalValue = true;
      this._description = "";
      this._summary = "";
      this._argsDescription = undefined;
      this._enablePositionalOptions = false;
      this._passThroughOptions = false;
      this._lifeCycleHooks = {};
      this._showHelpAfterError = false;
      this._showSuggestionAfterError = true;
      this._outputConfiguration = {
        writeOut: (str) => process2.stdout.write(str),
        writeErr: (str) => process2.stderr.write(str),
        getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : undefined,
        getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : undefined,
        outputError: (str, write) => write(str)
      };
      this._hidden = false;
      this._helpOption = undefined;
      this._addImplicitHelpCommand = undefined;
      this._helpCommand = undefined;
      this._helpConfiguration = {};
    }
    copyInheritedSettings(sourceCommand) {
      this._outputConfiguration = sourceCommand._outputConfiguration;
      this._helpOption = sourceCommand._helpOption;
      this._helpCommand = sourceCommand._helpCommand;
      this._helpConfiguration = sourceCommand._helpConfiguration;
      this._exitCallback = sourceCommand._exitCallback;
      this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
      this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
      this._allowExcessArguments = sourceCommand._allowExcessArguments;
      this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
      this._showHelpAfterError = sourceCommand._showHelpAfterError;
      this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
      return this;
    }
    _getCommandAndAncestors() {
      const result = [];
      for (let command = this;command; command = command.parent) {
        result.push(command);
      }
      return result;
    }
    command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
      let desc = actionOptsOrExecDesc;
      let opts = execOpts;
      if (typeof desc === "object" && desc !== null) {
        opts = desc;
        desc = null;
      }
      opts = opts || {};
      const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
      const cmd = this.createCommand(name);
      if (desc) {
        cmd.description(desc);
        cmd._executableHandler = true;
      }
      if (opts.isDefault)
        this._defaultCommandName = cmd._name;
      cmd._hidden = !!(opts.noHelp || opts.hidden);
      cmd._executableFile = opts.executableFile || null;
      if (args)
        cmd.arguments(args);
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd.copyInheritedSettings(this);
      if (desc)
        return this;
      return cmd;
    }
    createCommand(name) {
      return new Command(name);
    }
    createHelp() {
      return Object.assign(new Help, this.configureHelp());
    }
    configureHelp(configuration) {
      if (configuration === undefined)
        return this._helpConfiguration;
      this._helpConfiguration = configuration;
      return this;
    }
    configureOutput(configuration) {
      if (configuration === undefined)
        return this._outputConfiguration;
      Object.assign(this._outputConfiguration, configuration);
      return this;
    }
    showHelpAfterError(displayHelp = true) {
      if (typeof displayHelp !== "string")
        displayHelp = !!displayHelp;
      this._showHelpAfterError = displayHelp;
      return this;
    }
    showSuggestionAfterError(displaySuggestion = true) {
      this._showSuggestionAfterError = !!displaySuggestion;
      return this;
    }
    addCommand(cmd, opts) {
      if (!cmd._name) {
        throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
      }
      opts = opts || {};
      if (opts.isDefault)
        this._defaultCommandName = cmd._name;
      if (opts.noHelp || opts.hidden)
        cmd._hidden = true;
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd._checkForBrokenPassThrough();
      return this;
    }
    createArgument(name, description) {
      return new Argument(name, description);
    }
    argument(name, description, fn, defaultValue) {
      const argument = this.createArgument(name, description);
      if (typeof fn === "function") {
        argument.default(defaultValue).argParser(fn);
      } else {
        argument.default(fn);
      }
      this.addArgument(argument);
      return this;
    }
    arguments(names) {
      names.trim().split(/ +/).forEach((detail) => {
        this.argument(detail);
      });
      return this;
    }
    addArgument(argument) {
      const previousArgument = this.registeredArguments.slice(-1)[0];
      if (previousArgument && previousArgument.variadic) {
        throw new Error(`only the last argument can be variadic '${previousArgument.name()}'`);
      }
      if (argument.required && argument.defaultValue !== undefined && argument.parseArg === undefined) {
        throw new Error(`a default value for a required argument is never used: '${argument.name()}'`);
      }
      this.registeredArguments.push(argument);
      return this;
    }
    helpCommand(enableOrNameAndArgs, description) {
      if (typeof enableOrNameAndArgs === "boolean") {
        this._addImplicitHelpCommand = enableOrNameAndArgs;
        return this;
      }
      enableOrNameAndArgs = enableOrNameAndArgs ?? "help [command]";
      const [, helpName, helpArgs] = enableOrNameAndArgs.match(/([^ ]+) *(.*)/);
      const helpDescription = description ?? "display help for command";
      const helpCommand = this.createCommand(helpName);
      helpCommand.helpOption(false);
      if (helpArgs)
        helpCommand.arguments(helpArgs);
      if (helpDescription)
        helpCommand.description(helpDescription);
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      return this;
    }
    addHelpCommand(helpCommand, deprecatedDescription) {
      if (typeof helpCommand !== "object") {
        this.helpCommand(helpCommand, deprecatedDescription);
        return this;
      }
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      return this;
    }
    _getHelpCommand() {
      const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
      if (hasImplicitHelpCommand) {
        if (this._helpCommand === undefined) {
          this.helpCommand(undefined, undefined);
        }
        return this._helpCommand;
      }
      return null;
    }
    hook(event, listener) {
      const allowedValues = ["preSubcommand", "preAction", "postAction"];
      if (!allowedValues.includes(event)) {
        throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      if (this._lifeCycleHooks[event]) {
        this._lifeCycleHooks[event].push(listener);
      } else {
        this._lifeCycleHooks[event] = [listener];
      }
      return this;
    }
    exitOverride(fn) {
      if (fn) {
        this._exitCallback = fn;
      } else {
        this._exitCallback = (err) => {
          if (err.code !== "commander.executeSubCommandAsync") {
            throw err;
          }
        };
      }
      return this;
    }
    _exit(exitCode, code, message) {
      if (this._exitCallback) {
        this._exitCallback(new CommanderError(exitCode, code, message));
      }
      process2.exit(exitCode);
    }
    action(fn) {
      const listener = (args) => {
        const expectedArgsCount = this.registeredArguments.length;
        const actionArgs = args.slice(0, expectedArgsCount);
        if (this._storeOptionsAsProperties) {
          actionArgs[expectedArgsCount] = this;
        } else {
          actionArgs[expectedArgsCount] = this.opts();
        }
        actionArgs.push(this);
        return fn.apply(this, actionArgs);
      };
      this._actionHandler = listener;
      return this;
    }
    createOption(flags, description) {
      return new Option(flags, description);
    }
    _callParseArg(target, value, previous, invalidArgumentMessage) {
      try {
        return target.parseArg(value, previous);
      } catch (err) {
        if (err.code === "commander.invalidArgument") {
          const message = `${invalidArgumentMessage} ${err.message}`;
          this.error(message, { exitCode: err.exitCode, code: err.code });
        }
        throw err;
      }
    }
    _registerOption(option) {
      const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
      if (matchingOption) {
        const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
        throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
      }
      this.options.push(option);
    }
    _registerCommand(command) {
      const knownBy = (cmd) => {
        return [cmd.name()].concat(cmd.aliases());
      };
      const alreadyUsed = knownBy(command).find((name) => this._findCommand(name));
      if (alreadyUsed) {
        const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
        const newCmd = knownBy(command).join("|");
        throw new Error(`cannot add command '${newCmd}' as already have command '${existingCmd}'`);
      }
      this.commands.push(command);
    }
    addOption(option) {
      this._registerOption(option);
      const oname = option.name();
      const name = option.attributeName();
      if (option.negate) {
        const positiveLongFlag = option.long.replace(/^--no-/, "--");
        if (!this._findOption(positiveLongFlag)) {
          this.setOptionValueWithSource(name, option.defaultValue === undefined ? true : option.defaultValue, "default");
        }
      } else if (option.defaultValue !== undefined) {
        this.setOptionValueWithSource(name, option.defaultValue, "default");
      }
      const handleOptionValue = (val, invalidValueMessage, valueSource) => {
        if (val == null && option.presetArg !== undefined) {
          val = option.presetArg;
        }
        const oldValue = this.getOptionValue(name);
        if (val !== null && option.parseArg) {
          val = this._callParseArg(option, val, oldValue, invalidValueMessage);
        } else if (val !== null && option.variadic) {
          val = option._concatValue(val, oldValue);
        }
        if (val == null) {
          if (option.negate) {
            val = false;
          } else if (option.isBoolean() || option.optional) {
            val = true;
          } else {
            val = "";
          }
        }
        this.setOptionValueWithSource(name, val, valueSource);
      };
      this.on("option:" + oname, (val) => {
        const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
        handleOptionValue(val, invalidValueMessage, "cli");
      });
      if (option.envVar) {
        this.on("optionEnv:" + oname, (val) => {
          const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, "env");
        });
      }
      return this;
    }
    _optionEx(config, flags, description, fn, defaultValue) {
      if (typeof flags === "object" && flags instanceof Option) {
        throw new Error("To add an Option object use addOption() instead of option() or requiredOption()");
      }
      const option = this.createOption(flags, description);
      option.makeOptionMandatory(!!config.mandatory);
      if (typeof fn === "function") {
        option.default(defaultValue).argParser(fn);
      } else if (fn instanceof RegExp) {
        const regex = fn;
        fn = (val, def) => {
          const m = regex.exec(val);
          return m ? m[0] : def;
        };
        option.default(defaultValue).argParser(fn);
      } else {
        option.default(fn);
      }
      return this.addOption(option);
    }
    option(flags, description, parseArg, defaultValue) {
      return this._optionEx({}, flags, description, parseArg, defaultValue);
    }
    requiredOption(flags, description, parseArg, defaultValue) {
      return this._optionEx({ mandatory: true }, flags, description, parseArg, defaultValue);
    }
    combineFlagAndOptionalValue(combine = true) {
      this._combineFlagAndOptionalValue = !!combine;
      return this;
    }
    allowUnknownOption(allowUnknown = true) {
      this._allowUnknownOption = !!allowUnknown;
      return this;
    }
    allowExcessArguments(allowExcess = true) {
      this._allowExcessArguments = !!allowExcess;
      return this;
    }
    enablePositionalOptions(positional = true) {
      this._enablePositionalOptions = !!positional;
      return this;
    }
    passThroughOptions(passThrough = true) {
      this._passThroughOptions = !!passThrough;
      this._checkForBrokenPassThrough();
      return this;
    }
    _checkForBrokenPassThrough() {
      if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
        throw new Error(`passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`);
      }
    }
    storeOptionsAsProperties(storeAsProperties = true) {
      if (this.options.length) {
        throw new Error("call .storeOptionsAsProperties() before adding options");
      }
      if (Object.keys(this._optionValues).length) {
        throw new Error("call .storeOptionsAsProperties() before setting option values");
      }
      this._storeOptionsAsProperties = !!storeAsProperties;
      return this;
    }
    getOptionValue(key) {
      if (this._storeOptionsAsProperties) {
        return this[key];
      }
      return this._optionValues[key];
    }
    setOptionValue(key, value) {
      return this.setOptionValueWithSource(key, value, undefined);
    }
    setOptionValueWithSource(key, value, source) {
      if (this._storeOptionsAsProperties) {
        this[key] = value;
      } else {
        this._optionValues[key] = value;
      }
      this._optionValueSources[key] = source;
      return this;
    }
    getOptionValueSource(key) {
      return this._optionValueSources[key];
    }
    getOptionValueSourceWithGlobals(key) {
      let source;
      this._getCommandAndAncestors().forEach((cmd) => {
        if (cmd.getOptionValueSource(key) !== undefined) {
          source = cmd.getOptionValueSource(key);
        }
      });
      return source;
    }
    _prepareUserArgs(argv, parseOptions) {
      if (argv !== undefined && !Array.isArray(argv)) {
        throw new Error("first parameter to parse must be array or undefined");
      }
      parseOptions = parseOptions || {};
      if (argv === undefined && parseOptions.from === undefined) {
        if (process2.versions?.electron) {
          parseOptions.from = "electron";
        }
        const execArgv = process2.execArgv ?? [];
        if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
          parseOptions.from = "eval";
        }
      }
      if (argv === undefined) {
        argv = process2.argv;
      }
      this.rawArgs = argv.slice();
      let userArgs;
      switch (parseOptions.from) {
        case undefined:
        case "node":
          this._scriptPath = argv[1];
          userArgs = argv.slice(2);
          break;
        case "electron":
          if (process2.defaultApp) {
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
          } else {
            userArgs = argv.slice(1);
          }
          break;
        case "user":
          userArgs = argv.slice(0);
          break;
        case "eval":
          userArgs = argv.slice(1);
          break;
        default:
          throw new Error(`unexpected parse option { from: '${parseOptions.from}' }`);
      }
      if (!this._name && this._scriptPath)
        this.nameFromFilename(this._scriptPath);
      this._name = this._name || "program";
      return userArgs;
    }
    parse(argv, parseOptions) {
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      this._parseCommand([], userArgs);
      return this;
    }
    async parseAsync(argv, parseOptions) {
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      await this._parseCommand([], userArgs);
      return this;
    }
    _executeSubCommand(subcommand, args) {
      args = args.slice();
      let launchWithNode = false;
      const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
      function findFile(baseDir, baseName) {
        const localBin = path.resolve(baseDir, baseName);
        if (fs.existsSync(localBin))
          return localBin;
        if (sourceExt.includes(path.extname(baseName)))
          return;
        const foundExt = sourceExt.find((ext) => fs.existsSync(`${localBin}${ext}`));
        if (foundExt)
          return `${localBin}${foundExt}`;
        return;
      }
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
      let executableDir = this._executableDir || "";
      if (this._scriptPath) {
        let resolvedScriptPath;
        try {
          resolvedScriptPath = fs.realpathSync(this._scriptPath);
        } catch (err) {
          resolvedScriptPath = this._scriptPath;
        }
        executableDir = path.resolve(path.dirname(resolvedScriptPath), executableDir);
      }
      if (executableDir) {
        let localFile = findFile(executableDir, executableFile);
        if (!localFile && !subcommand._executableFile && this._scriptPath) {
          const legacyName = path.basename(this._scriptPath, path.extname(this._scriptPath));
          if (legacyName !== this._name) {
            localFile = findFile(executableDir, `${legacyName}-${subcommand._name}`);
          }
        }
        executableFile = localFile || executableFile;
      }
      launchWithNode = sourceExt.includes(path.extname(executableFile));
      let proc;
      if (process2.platform !== "win32") {
        if (launchWithNode) {
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
        } else {
          proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
        }
      } else {
        args.unshift(executableFile);
        args = incrementNodeInspectorPort(process2.execArgv).concat(args);
        proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
      }
      if (!proc.killed) {
        const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
        signals.forEach((signal) => {
          process2.on(signal, () => {
            if (proc.killed === false && proc.exitCode === null) {
              proc.kill(signal);
            }
          });
        });
      }
      const exitCallback = this._exitCallback;
      proc.on("close", (code) => {
        code = code ?? 1;
        if (!exitCallback) {
          process2.exit(code);
        } else {
          exitCallback(new CommanderError(code, "commander.executeSubCommandAsync", "(close)"));
        }
      });
      proc.on("error", (err) => {
        if (err.code === "ENOENT") {
          const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
          const executableMissing = `'${executableFile}' does not exist
 - if '${subcommand._name}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
          throw new Error(executableMissing);
        } else if (err.code === "EACCES") {
          throw new Error(`'${executableFile}' not executable`);
        }
        if (!exitCallback) {
          process2.exit(1);
        } else {
          const wrappedError = new CommanderError(1, "commander.executeSubCommandAsync", "(error)");
          wrappedError.nestedError = err;
          exitCallback(wrappedError);
        }
      });
      this.runningCommand = proc;
    }
    _dispatchSubcommand(commandName, operands, unknown) {
      const subCommand = this._findCommand(commandName);
      if (!subCommand)
        this.help({ error: true });
      let promiseChain;
      promiseChain = this._chainOrCallSubCommandHook(promiseChain, subCommand, "preSubcommand");
      promiseChain = this._chainOrCall(promiseChain, () => {
        if (subCommand._executableHandler) {
          this._executeSubCommand(subCommand, operands.concat(unknown));
        } else {
          return subCommand._parseCommand(operands, unknown);
        }
      });
      return promiseChain;
    }
    _dispatchHelpCommand(subcommandName) {
      if (!subcommandName) {
        this.help();
      }
      const subCommand = this._findCommand(subcommandName);
      if (subCommand && !subCommand._executableHandler) {
        subCommand.help();
      }
      return this._dispatchSubcommand(subcommandName, [], [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]);
    }
    _checkNumberOfArguments() {
      this.registeredArguments.forEach((arg, i) => {
        if (arg.required && this.args[i] == null) {
          this.missingArgument(arg.name());
        }
      });
      if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
        return;
      }
      if (this.args.length > this.registeredArguments.length) {
        this._excessArguments(this.args);
      }
    }
    _processArguments() {
      const myParseArg = (argument, value, previous) => {
        let parsedValue = value;
        if (value !== null && argument.parseArg) {
          const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
          parsedValue = this._callParseArg(argument, value, previous, invalidValueMessage);
        }
        return parsedValue;
      };
      this._checkNumberOfArguments();
      const processedArgs = [];
      this.registeredArguments.forEach((declaredArg, index) => {
        let value = declaredArg.defaultValue;
        if (declaredArg.variadic) {
          if (index < this.args.length) {
            value = this.args.slice(index);
            if (declaredArg.parseArg) {
              value = value.reduce((processed, v) => {
                return myParseArg(declaredArg, v, processed);
              }, declaredArg.defaultValue);
            }
          } else if (value === undefined) {
            value = [];
          }
        } else if (index < this.args.length) {
          value = this.args[index];
          if (declaredArg.parseArg) {
            value = myParseArg(declaredArg, value, declaredArg.defaultValue);
          }
        }
        processedArgs[index] = value;
      });
      this.processedArgs = processedArgs;
    }
    _chainOrCall(promise, fn) {
      if (promise && promise.then && typeof promise.then === "function") {
        return promise.then(() => fn());
      }
      return fn();
    }
    _chainOrCallHooks(promise, event) {
      let result = promise;
      const hooks = [];
      this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== undefined).forEach((hookedCommand) => {
        hookedCommand._lifeCycleHooks[event].forEach((callback) => {
          hooks.push({ hookedCommand, callback });
        });
      });
      if (event === "postAction") {
        hooks.reverse();
      }
      hooks.forEach((hookDetail) => {
        result = this._chainOrCall(result, () => {
          return hookDetail.callback(hookDetail.hookedCommand, this);
        });
      });
      return result;
    }
    _chainOrCallSubCommandHook(promise, subCommand, event) {
      let result = promise;
      if (this._lifeCycleHooks[event] !== undefined) {
        this._lifeCycleHooks[event].forEach((hook) => {
          result = this._chainOrCall(result, () => {
            return hook(this, subCommand);
          });
        });
      }
      return result;
    }
    _parseCommand(operands, unknown) {
      const parsed = this.parseOptions(unknown);
      this._parseOptionsEnv();
      this._parseOptionsImplied();
      operands = operands.concat(parsed.operands);
      unknown = parsed.unknown;
      this.args = operands.concat(unknown);
      if (operands && this._findCommand(operands[0])) {
        return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
      }
      if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
        return this._dispatchHelpCommand(operands[1]);
      }
      if (this._defaultCommandName) {
        this._outputHelpIfRequested(unknown);
        return this._dispatchSubcommand(this._defaultCommandName, operands, unknown);
      }
      if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
        this.help({ error: true });
      }
      this._outputHelpIfRequested(parsed.unknown);
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      const checkForUnknownOptions = () => {
        if (parsed.unknown.length > 0) {
          this.unknownOption(parsed.unknown[0]);
        }
      };
      const commandEvent = `command:${this.name()}`;
      if (this._actionHandler) {
        checkForUnknownOptions();
        this._processArguments();
        let promiseChain;
        promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
        promiseChain = this._chainOrCall(promiseChain, () => this._actionHandler(this.processedArgs));
        if (this.parent) {
          promiseChain = this._chainOrCall(promiseChain, () => {
            this.parent.emit(commandEvent, operands, unknown);
          });
        }
        promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
        return promiseChain;
      }
      if (this.parent && this.parent.listenerCount(commandEvent)) {
        checkForUnknownOptions();
        this._processArguments();
        this.parent.emit(commandEvent, operands, unknown);
      } else if (operands.length) {
        if (this._findCommand("*")) {
          return this._dispatchSubcommand("*", operands, unknown);
        }
        if (this.listenerCount("command:*")) {
          this.emit("command:*", operands, unknown);
        } else if (this.commands.length) {
          this.unknownCommand();
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      } else if (this.commands.length) {
        checkForUnknownOptions();
        this.help({ error: true });
      } else {
        checkForUnknownOptions();
        this._processArguments();
      }
    }
    _findCommand(name) {
      if (!name)
        return;
      return this.commands.find((cmd) => cmd._name === name || cmd._aliases.includes(name));
    }
    _findOption(arg) {
      return this.options.find((option) => option.is(arg));
    }
    _checkForMissingMandatoryOptions() {
      this._getCommandAndAncestors().forEach((cmd) => {
        cmd.options.forEach((anOption) => {
          if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === undefined) {
            cmd.missingMandatoryOptionValue(anOption);
          }
        });
      });
    }
    _checkForConflictingLocalOptions() {
      const definedNonDefaultOptions = this.options.filter((option) => {
        const optionKey = option.attributeName();
        if (this.getOptionValue(optionKey) === undefined) {
          return false;
        }
        return this.getOptionValueSource(optionKey) !== "default";
      });
      const optionsWithConflicting = definedNonDefaultOptions.filter((option) => option.conflictsWith.length > 0);
      optionsWithConflicting.forEach((option) => {
        const conflictingAndDefined = definedNonDefaultOptions.find((defined) => option.conflictsWith.includes(defined.attributeName()));
        if (conflictingAndDefined) {
          this._conflictingOption(option, conflictingAndDefined);
        }
      });
    }
    _checkForConflictingOptions() {
      this._getCommandAndAncestors().forEach((cmd) => {
        cmd._checkForConflictingLocalOptions();
      });
    }
    parseOptions(argv) {
      const operands = [];
      const unknown = [];
      let dest = operands;
      const args = argv.slice();
      function maybeOption(arg) {
        return arg.length > 1 && arg[0] === "-";
      }
      let activeVariadicOption = null;
      while (args.length) {
        const arg = args.shift();
        if (arg === "--") {
          if (dest === unknown)
            dest.push(arg);
          dest.push(...args);
          break;
        }
        if (activeVariadicOption && !maybeOption(arg)) {
          this.emit(`option:${activeVariadicOption.name()}`, arg);
          continue;
        }
        activeVariadicOption = null;
        if (maybeOption(arg)) {
          const option = this._findOption(arg);
          if (option) {
            if (option.required) {
              const value = args.shift();
              if (value === undefined)
                this.optionMissingArgument(option);
              this.emit(`option:${option.name()}`, value);
            } else if (option.optional) {
              let value = null;
              if (args.length > 0 && !maybeOption(args[0])) {
                value = args.shift();
              }
              this.emit(`option:${option.name()}`, value);
            } else {
              this.emit(`option:${option.name()}`);
            }
            activeVariadicOption = option.variadic ? option : null;
            continue;
          }
        }
        if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
          const option = this._findOption(`-${arg[1]}`);
          if (option) {
            if (option.required || option.optional && this._combineFlagAndOptionalValue) {
              this.emit(`option:${option.name()}`, arg.slice(2));
            } else {
              this.emit(`option:${option.name()}`);
              args.unshift(`-${arg.slice(2)}`);
            }
            continue;
          }
        }
        if (/^--[^=]+=/.test(arg)) {
          const index = arg.indexOf("=");
          const option = this._findOption(arg.slice(0, index));
          if (option && (option.required || option.optional)) {
            this.emit(`option:${option.name()}`, arg.slice(index + 1));
            continue;
          }
        }
        if (maybeOption(arg)) {
          dest = unknown;
        }
        if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
          if (this._findCommand(arg)) {
            operands.push(arg);
            if (args.length > 0)
              unknown.push(...args);
            break;
          } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
            operands.push(arg);
            if (args.length > 0)
              operands.push(...args);
            break;
          } else if (this._defaultCommandName) {
            unknown.push(arg);
            if (args.length > 0)
              unknown.push(...args);
            break;
          }
        }
        if (this._passThroughOptions) {
          dest.push(arg);
          if (args.length > 0)
            dest.push(...args);
          break;
        }
        dest.push(arg);
      }
      return { operands, unknown };
    }
    opts() {
      if (this._storeOptionsAsProperties) {
        const result = {};
        const len = this.options.length;
        for (let i = 0;i < len; i++) {
          const key = this.options[i].attributeName();
          result[key] = key === this._versionOptionName ? this._version : this[key];
        }
        return result;
      }
      return this._optionValues;
    }
    optsWithGlobals() {
      return this._getCommandAndAncestors().reduce((combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()), {});
    }
    error(message, errorOptions) {
      this._outputConfiguration.outputError(`${message}
`, this._outputConfiguration.writeErr);
      if (typeof this._showHelpAfterError === "string") {
        this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
      } else if (this._showHelpAfterError) {
        this._outputConfiguration.writeErr(`
`);
        this.outputHelp({ error: true });
      }
      const config = errorOptions || {};
      const exitCode = config.exitCode || 1;
      const code = config.code || "commander.error";
      this._exit(exitCode, code, message);
    }
    _parseOptionsEnv() {
      this.options.forEach((option) => {
        if (option.envVar && option.envVar in process2.env) {
          const optionKey = option.attributeName();
          if (this.getOptionValue(optionKey) === undefined || ["default", "config", "env"].includes(this.getOptionValueSource(optionKey))) {
            if (option.required || option.optional) {
              this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
            } else {
              this.emit(`optionEnv:${option.name()}`);
            }
          }
        }
      });
    }
    _parseOptionsImplied() {
      const dualHelper = new DualOptions(this.options);
      const hasCustomOptionValue = (optionKey) => {
        return this.getOptionValue(optionKey) !== undefined && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
      };
      this.options.filter((option) => option.implied !== undefined && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(this.getOptionValue(option.attributeName()), option)).forEach((option) => {
        Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
          this.setOptionValueWithSource(impliedKey, option.implied[impliedKey], "implied");
        });
      });
    }
    missingArgument(name) {
      const message = `error: missing required argument '${name}'`;
      this.error(message, { code: "commander.missingArgument" });
    }
    optionMissingArgument(option) {
      const message = `error: option '${option.flags}' argument missing`;
      this.error(message, { code: "commander.optionMissingArgument" });
    }
    missingMandatoryOptionValue(option) {
      const message = `error: required option '${option.flags}' not specified`;
      this.error(message, { code: "commander.missingMandatoryOptionValue" });
    }
    _conflictingOption(option, conflictingOption) {
      const findBestOptionFromValue = (option2) => {
        const optionKey = option2.attributeName();
        const optionValue = this.getOptionValue(optionKey);
        const negativeOption = this.options.find((target) => target.negate && optionKey === target.attributeName());
        const positiveOption = this.options.find((target) => !target.negate && optionKey === target.attributeName());
        if (negativeOption && (negativeOption.presetArg === undefined && optionValue === false || negativeOption.presetArg !== undefined && optionValue === negativeOption.presetArg)) {
          return negativeOption;
        }
        return positiveOption || option2;
      };
      const getErrorMessage = (option2) => {
        const bestOption = findBestOptionFromValue(option2);
        const optionKey = bestOption.attributeName();
        const source = this.getOptionValueSource(optionKey);
        if (source === "env") {
          return `environment variable '${bestOption.envVar}'`;
        }
        return `option '${bestOption.flags}'`;
      };
      const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
      this.error(message, { code: "commander.conflictingOption" });
    }
    unknownOption(flag) {
      if (this._allowUnknownOption)
        return;
      let suggestion = "";
      if (flag.startsWith("--") && this._showSuggestionAfterError) {
        let candidateFlags = [];
        let command = this;
        do {
          const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
          candidateFlags = candidateFlags.concat(moreFlags);
          command = command.parent;
        } while (command && !command._enablePositionalOptions);
        suggestion = suggestSimilar(flag, candidateFlags);
      }
      const message = `error: unknown option '${flag}'${suggestion}`;
      this.error(message, { code: "commander.unknownOption" });
    }
    _excessArguments(receivedArgs) {
      if (this._allowExcessArguments)
        return;
      const expected = this.registeredArguments.length;
      const s = expected === 1 ? "" : "s";
      const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
      const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
      this.error(message, { code: "commander.excessArguments" });
    }
    unknownCommand() {
      const unknownName = this.args[0];
      let suggestion = "";
      if (this._showSuggestionAfterError) {
        const candidateNames = [];
        this.createHelp().visibleCommands(this).forEach((command) => {
          candidateNames.push(command.name());
          if (command.alias())
            candidateNames.push(command.alias());
        });
        suggestion = suggestSimilar(unknownName, candidateNames);
      }
      const message = `error: unknown command '${unknownName}'${suggestion}`;
      this.error(message, { code: "commander.unknownCommand" });
    }
    version(str, flags, description) {
      if (str === undefined)
        return this._version;
      this._version = str;
      flags = flags || "-V, --version";
      description = description || "output the version number";
      const versionOption = this.createOption(flags, description);
      this._versionOptionName = versionOption.attributeName();
      this._registerOption(versionOption);
      this.on("option:" + versionOption.name(), () => {
        this._outputConfiguration.writeOut(`${str}
`);
        this._exit(0, "commander.version", str);
      });
      return this;
    }
    description(str, argsDescription) {
      if (str === undefined && argsDescription === undefined)
        return this._description;
      this._description = str;
      if (argsDescription) {
        this._argsDescription = argsDescription;
      }
      return this;
    }
    summary(str) {
      if (str === undefined)
        return this._summary;
      this._summary = str;
      return this;
    }
    alias(alias) {
      if (alias === undefined)
        return this._aliases[0];
      let command = this;
      if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
        command = this.commands[this.commands.length - 1];
      }
      if (alias === command._name)
        throw new Error("Command alias can't be the same as its name");
      const matchingCommand = this.parent?._findCommand(alias);
      if (matchingCommand) {
        const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
        throw new Error(`cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`);
      }
      command._aliases.push(alias);
      return this;
    }
    aliases(aliases) {
      if (aliases === undefined)
        return this._aliases;
      aliases.forEach((alias) => this.alias(alias));
      return this;
    }
    usage(str) {
      if (str === undefined) {
        if (this._usage)
          return this._usage;
        const args = this.registeredArguments.map((arg) => {
          return humanReadableArgName(arg);
        });
        return [].concat(this.options.length || this._helpOption !== null ? "[options]" : [], this.commands.length ? "[command]" : [], this.registeredArguments.length ? args : []).join(" ");
      }
      this._usage = str;
      return this;
    }
    name(str) {
      if (str === undefined)
        return this._name;
      this._name = str;
      return this;
    }
    nameFromFilename(filename) {
      this._name = path.basename(filename, path.extname(filename));
      return this;
    }
    executableDir(path2) {
      if (path2 === undefined)
        return this._executableDir;
      this._executableDir = path2;
      return this;
    }
    helpInformation(contextOptions) {
      const helper = this.createHelp();
      if (helper.helpWidth === undefined) {
        helper.helpWidth = contextOptions && contextOptions.error ? this._outputConfiguration.getErrHelpWidth() : this._outputConfiguration.getOutHelpWidth();
      }
      return helper.formatHelp(this, helper);
    }
    _getHelpContext(contextOptions) {
      contextOptions = contextOptions || {};
      const context = { error: !!contextOptions.error };
      let write;
      if (context.error) {
        write = (arg) => this._outputConfiguration.writeErr(arg);
      } else {
        write = (arg) => this._outputConfiguration.writeOut(arg);
      }
      context.write = contextOptions.write || write;
      context.command = this;
      return context;
    }
    outputHelp(contextOptions) {
      let deprecatedCallback;
      if (typeof contextOptions === "function") {
        deprecatedCallback = contextOptions;
        contextOptions = undefined;
      }
      const context = this._getHelpContext(contextOptions);
      this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", context));
      this.emit("beforeHelp", context);
      let helpInformation = this.helpInformation(context);
      if (deprecatedCallback) {
        helpInformation = deprecatedCallback(helpInformation);
        if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
          throw new Error("outputHelp callback must return a string or a Buffer");
        }
      }
      context.write(helpInformation);
      if (this._getHelpOption()?.long) {
        this.emit(this._getHelpOption().long);
      }
      this.emit("afterHelp", context);
      this._getCommandAndAncestors().forEach((command) => command.emit("afterAllHelp", context));
    }
    helpOption(flags, description) {
      if (typeof flags === "boolean") {
        if (flags) {
          this._helpOption = this._helpOption ?? undefined;
        } else {
          this._helpOption = null;
        }
        return this;
      }
      flags = flags ?? "-h, --help";
      description = description ?? "display help for command";
      this._helpOption = this.createOption(flags, description);
      return this;
    }
    _getHelpOption() {
      if (this._helpOption === undefined) {
        this.helpOption(undefined, undefined);
      }
      return this._helpOption;
    }
    addHelpOption(option) {
      this._helpOption = option;
      return this;
    }
    help(contextOptions) {
      this.outputHelp(contextOptions);
      let exitCode = process2.exitCode || 0;
      if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
        exitCode = 1;
      }
      this._exit(exitCode, "commander.help", "(outputHelp)");
    }
    addHelpText(position, text) {
      const allowedValues = ["beforeAll", "before", "after", "afterAll"];
      if (!allowedValues.includes(position)) {
        throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      const helpEvent = `${position}Help`;
      this.on(helpEvent, (context) => {
        let helpStr;
        if (typeof text === "function") {
          helpStr = text({ error: context.error, command: context.command });
        } else {
          helpStr = text;
        }
        if (helpStr) {
          context.write(`${helpStr}
`);
        }
      });
      return this;
    }
    _outputHelpIfRequested(args) {
      const helpOption = this._getHelpOption();
      const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
      if (helpRequested) {
        this.outputHelp();
        this._exit(0, "commander.helpDisplayed", "(outputHelp)");
      }
    }
  }
  function incrementNodeInspectorPort(args) {
    return args.map((arg) => {
      if (!arg.startsWith("--inspect")) {
        return arg;
      }
      let debugOption;
      let debugHost = "127.0.0.1";
      let debugPort = "9229";
      let match;
      if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
        debugOption = match[1];
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
        debugOption = match[1];
        if (/^\d+$/.test(match[3])) {
          debugPort = match[3];
        } else {
          debugHost = match[3];
        }
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
        debugOption = match[1];
        debugHost = match[3];
        debugPort = match[4];
      }
      if (debugOption && debugPort !== "0") {
        return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
      }
      return arg;
    });
  }
  exports.Command = Command;
});

// node_modules/commander/index.js
var require_commander = __commonJS((exports) => {
  var { Argument } = require_argument();
  var { Command } = require_command();
  var { CommanderError, InvalidArgumentError } = require_error();
  var { Help } = require_help();
  var { Option } = require_option();
  exports.program = new Command;
  exports.createCommand = (name) => new Command(name);
  exports.createOption = (flags, description) => new Option(flags, description);
  exports.createArgument = (name, description) => new Argument(name, description);
  exports.Command = Command;
  exports.Option = Option;
  exports.Argument = Argument;
  exports.Help = Help;
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
  exports.InvalidOptionArgumentError = InvalidArgumentError;
});

// node_modules/commander/esm.mjs
var import__ = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  Command,
  Argument,
  Option,
  Help
} = import__.default;

// node_modules/twitter-api-v2/dist/esm/globals.js
var API_V2_PREFIX = "https://api.x.com/2/";
var API_V2_LABS_PREFIX = "https://api.x.com/labs/2/";
var API_V1_1_PREFIX = "https://api.x.com/1.1/";
var API_V1_1_UPLOAD_PREFIX = "https://upload.x.com/1.1/";
var API_V1_1_STREAM_PREFIX = "https://stream.x.com/1.1/";
var API_ADS_PREFIX = "https://ads-api.x.com/12/";
var API_ADS_SANDBOX_PREFIX = "https://ads-api-sandbox.twitter.com/12/";

// node_modules/twitter-api-v2/dist/esm/paginators/TwitterPaginator.js
class TwitterPaginator {
  constructor({ realData, rateLimit, instance, queryParams, sharedParams }) {
    this._maxResultsWhenFetchLast = 100;
    this._realData = realData;
    this._rateLimit = rateLimit;
    this._instance = instance;
    this._queryParams = queryParams;
    this._sharedParams = sharedParams;
  }
  get _isRateLimitOk() {
    if (!this._rateLimit) {
      return true;
    }
    const resetDate = this._rateLimit.reset * 1000;
    if (resetDate < Date.now()) {
      return true;
    }
    return this._rateLimit.remaining > 0;
  }
  makeRequest(queryParams) {
    return this._instance.get(this.getEndpoint(), queryParams, { fullResponse: true, params: this._sharedParams });
  }
  makeNewInstanceFromResult(result, queryParams) {
    return new this.constructor({
      realData: result.data,
      rateLimit: result.rateLimit,
      instance: this._instance,
      queryParams,
      sharedParams: this._sharedParams
    });
  }
  getEndpoint() {
    return this._endpoint;
  }
  injectQueryParams(maxResults) {
    return {
      ...maxResults ? { max_results: maxResults } : {},
      ...this._queryParams
    };
  }
  async next(maxResults) {
    const queryParams = this.getNextQueryParams(maxResults);
    const result = await this.makeRequest(queryParams);
    return this.makeNewInstanceFromResult(result, queryParams);
  }
  async fetchNext(maxResults) {
    const queryParams = this.getNextQueryParams(maxResults);
    const result = await this.makeRequest(queryParams);
    await this.refreshInstanceFromResult(result, true);
    return this;
  }
  async fetchLast(count = Infinity) {
    let queryParams = this.getNextQueryParams(this._maxResultsWhenFetchLast);
    let resultCount = 0;
    while (resultCount < count && this._isRateLimitOk) {
      const response = await this.makeRequest(queryParams);
      await this.refreshInstanceFromResult(response, true);
      resultCount += this.getPageLengthFromRequest(response);
      if (this.isFetchLastOver(response)) {
        break;
      }
      queryParams = this.getNextQueryParams(this._maxResultsWhenFetchLast);
    }
    return this;
  }
  get rateLimit() {
    var _a;
    return { ...(_a = this._rateLimit) !== null && _a !== undefined ? _a : {} };
  }
  get data() {
    return this._realData;
  }
  get done() {
    return !this.canFetchNextPage(this._realData);
  }
  *[Symbol.iterator]() {
    yield* this.getItemArray();
  }
  async* [Symbol.asyncIterator]() {
    yield* this.getItemArray();
    let paginator = this;
    let canFetchNextPage = this.canFetchNextPage(this._realData);
    while (canFetchNextPage && this._isRateLimitOk && paginator.getItemArray().length > 0) {
      const next = await paginator.next(this._maxResultsWhenFetchLast);
      this.refreshInstanceFromResult({ data: next._realData, headers: {}, rateLimit: next._rateLimit }, true);
      canFetchNextPage = this.canFetchNextPage(next._realData);
      const items = next.getItemArray();
      yield* items;
      paginator = next;
    }
  }
  async* fetchAndIterate() {
    for (const item of this.getItemArray()) {
      yield [item, this];
    }
    let paginator = this;
    let canFetchNextPage = this.canFetchNextPage(this._realData);
    while (canFetchNextPage && this._isRateLimitOk && paginator.getItemArray().length > 0) {
      const next = await paginator.next(this._maxResultsWhenFetchLast);
      this.refreshInstanceFromResult({ data: next._realData, headers: {}, rateLimit: next._rateLimit }, true);
      canFetchNextPage = this.canFetchNextPage(next._realData);
      for (const item of next.getItemArray()) {
        yield [item, next];
      }
      this._rateLimit = next._rateLimit;
      paginator = next;
    }
  }
}

class PreviousableTwitterPaginator extends TwitterPaginator {
  async previous(maxResults) {
    const queryParams = this.getPreviousQueryParams(maxResults);
    const result = await this.makeRequest(queryParams);
    return this.makeNewInstanceFromResult(result, queryParams);
  }
  async fetchPrevious(maxResults) {
    const queryParams = this.getPreviousQueryParams(maxResults);
    const result = await this.makeRequest(queryParams);
    await this.refreshInstanceFromResult(result, false);
    return this;
  }
}
var TwitterPaginator_default = TwitterPaginator;

// node_modules/twitter-api-v2/dist/esm/paginators/paginator.v1.js
class CursoredV1Paginator extends TwitterPaginator_default {
  getNextQueryParams(maxResults) {
    var _a;
    return {
      ...this._queryParams,
      cursor: (_a = this._realData.next_cursor_str) !== null && _a !== undefined ? _a : this._realData.next_cursor,
      ...maxResults ? { count: maxResults } : {}
    };
  }
  isFetchLastOver(result) {
    return !this.canFetchNextPage(result.data);
  }
  canFetchNextPage(result) {
    return !this.isNextCursorInvalid(result.next_cursor) || !this.isNextCursorInvalid(result.next_cursor_str);
  }
  isNextCursorInvalid(value) {
    return value === undefined || value === 0 || value === -1 || value === "0" || value === "-1";
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/dm.paginator.v1.js
class DmEventsV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "direct_messages/events/list.json";
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.events.push(...result.events);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.events.length;
  }
  getItemArray() {
    return this.events;
  }
  get events() {
    return this._realData.events;
  }
}

class WelcomeDmV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "direct_messages/welcome_messages/list.json";
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.welcome_messages.push(...result.welcome_messages);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.welcome_messages.length;
  }
  getItemArray() {
    return this.welcomeMessages;
  }
  get welcomeMessages() {
    return this._realData.welcome_messages;
  }
}
// node_modules/twitter-api-v2/dist/esm/types/v1/tweet.v1.types.js
var EUploadMimeType;
(function(EUploadMimeType2) {
  EUploadMimeType2["Jpeg"] = "image/jpeg";
  EUploadMimeType2["Mp4"] = "video/mp4";
  EUploadMimeType2["Mov"] = "video/quicktime";
  EUploadMimeType2["Gif"] = "image/gif";
  EUploadMimeType2["Png"] = "image/png";
  EUploadMimeType2["Srt"] = "text/plain";
  EUploadMimeType2["Webp"] = "image/webp";
})(EUploadMimeType || (EUploadMimeType = {}));
// node_modules/twitter-api-v2/dist/esm/types/v1/dm.v1.types.js
var EDirectMessageEventTypeV1;
(function(EDirectMessageEventTypeV12) {
  EDirectMessageEventTypeV12["Create"] = "message_create";
  EDirectMessageEventTypeV12["WelcomeCreate"] = "welcome_message";
})(EDirectMessageEventTypeV1 || (EDirectMessageEventTypeV1 = {}));
// node_modules/twitter-api-v2/dist/esm/types/errors.types.js
var ETwitterApiError;
(function(ETwitterApiError2) {
  ETwitterApiError2["Request"] = "request";
  ETwitterApiError2["PartialResponse"] = "partial-response";
  ETwitterApiError2["Response"] = "response";
})(ETwitterApiError || (ETwitterApiError = {}));

class ApiError extends Error {
  constructor() {
    super(...arguments);
    this.error = true;
  }
}

class ApiRequestError extends ApiError {
  constructor(message, options) {
    super(message);
    this.type = ETwitterApiError.Request;
    Error.captureStackTrace(this, this.constructor);
    Object.defineProperty(this, "_options", { value: options });
  }
  get request() {
    return this._options.request;
  }
  get requestError() {
    return this._options.requestError;
  }
  toJSON() {
    return {
      type: this.type,
      error: this.requestError
    };
  }
}

class ApiPartialResponseError extends ApiError {
  constructor(message, options) {
    super(message);
    this.type = ETwitterApiError.PartialResponse;
    Error.captureStackTrace(this, this.constructor);
    Object.defineProperty(this, "_options", { value: options });
  }
  get request() {
    return this._options.request;
  }
  get response() {
    return this._options.response;
  }
  get responseError() {
    return this._options.responseError;
  }
  get rawContent() {
    return this._options.rawContent;
  }
  toJSON() {
    return {
      type: this.type,
      error: this.responseError
    };
  }
}

class ApiResponseError extends ApiError {
  constructor(message, options) {
    super(message);
    this.type = ETwitterApiError.Response;
    Error.captureStackTrace(this, this.constructor);
    Object.defineProperty(this, "_options", { value: options });
    this.code = options.code;
    this.headers = options.headers;
    this.rateLimit = options.rateLimit;
    if (options.data && typeof options.data === "object" && "error" in options.data && !options.data.errors) {
      const data = { ...options.data };
      data.errors = [{
        code: EApiV1ErrorCode.InternalError,
        message: data.error
      }];
      this.data = data;
    } else {
      this.data = options.data;
    }
  }
  get request() {
    return this._options.request;
  }
  get response() {
    return this._options.response;
  }
  hasErrorCode(...codes) {
    const errors = this.errors;
    if (!(errors === null || errors === undefined ? undefined : errors.length)) {
      return false;
    }
    if ("code" in errors[0]) {
      const v1errors = errors;
      return v1errors.some((error) => codes.includes(error.code));
    }
    const v2error = this.data;
    return codes.includes(v2error.type);
  }
  get errors() {
    var _a;
    return (_a = this.data) === null || _a === undefined ? undefined : _a.errors;
  }
  get rateLimitError() {
    return this.code === 420 || this.code === 429;
  }
  get isAuthError() {
    if (this.code === 401) {
      return true;
    }
    return this.hasErrorCode(EApiV1ErrorCode.AuthTimestampInvalid, EApiV1ErrorCode.AuthenticationFail, EApiV1ErrorCode.BadAuthenticationData, EApiV1ErrorCode.InvalidOrExpiredToken);
  }
  toJSON() {
    return {
      type: this.type,
      code: this.code,
      error: this.data,
      rateLimit: this.rateLimit,
      headers: this.headers
    };
  }
}
var EApiV1ErrorCode;
(function(EApiV1ErrorCode2) {
  EApiV1ErrorCode2[EApiV1ErrorCode2["InvalidCoordinates"] = 3] = "InvalidCoordinates";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NoLocationFound"] = 13] = "NoLocationFound";
  EApiV1ErrorCode2[EApiV1ErrorCode2["AuthenticationFail"] = 32] = "AuthenticationFail";
  EApiV1ErrorCode2[EApiV1ErrorCode2["InvalidOrExpiredToken"] = 89] = "InvalidOrExpiredToken";
  EApiV1ErrorCode2[EApiV1ErrorCode2["UnableToVerifyCredentials"] = 99] = "UnableToVerifyCredentials";
  EApiV1ErrorCode2[EApiV1ErrorCode2["AuthTimestampInvalid"] = 135] = "AuthTimestampInvalid";
  EApiV1ErrorCode2[EApiV1ErrorCode2["BadAuthenticationData"] = 215] = "BadAuthenticationData";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NoUserMatch"] = 17] = "NoUserMatch";
  EApiV1ErrorCode2[EApiV1ErrorCode2["UserNotFound"] = 50] = "UserNotFound";
  EApiV1ErrorCode2[EApiV1ErrorCode2["ResourceNotFound"] = 34] = "ResourceNotFound";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetNotFound"] = 144] = "TweetNotFound";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetNotVisible"] = 179] = "TweetNotVisible";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NotAllowedResource"] = 220] = "NotAllowedResource";
  EApiV1ErrorCode2[EApiV1ErrorCode2["MediaIdNotFound"] = 325] = "MediaIdNotFound";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetNoLongerAvailable"] = 421] = "TweetNoLongerAvailable";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetViolatedRules"] = 422] = "TweetViolatedRules";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TargetUserSuspended"] = 63] = "TargetUserSuspended";
  EApiV1ErrorCode2[EApiV1ErrorCode2["YouAreSuspended"] = 64] = "YouAreSuspended";
  EApiV1ErrorCode2[EApiV1ErrorCode2["AccountUpdateFailed"] = 120] = "AccountUpdateFailed";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NoSelfSpamReport"] = 36] = "NoSelfSpamReport";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NoSelfMute"] = 271] = "NoSelfMute";
  EApiV1ErrorCode2[EApiV1ErrorCode2["AccountLocked"] = 326] = "AccountLocked";
  EApiV1ErrorCode2[EApiV1ErrorCode2["RateLimitExceeded"] = 88] = "RateLimitExceeded";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NoDMRightForApp"] = 93] = "NoDMRightForApp";
  EApiV1ErrorCode2[EApiV1ErrorCode2["OverCapacity"] = 130] = "OverCapacity";
  EApiV1ErrorCode2[EApiV1ErrorCode2["InternalError"] = 131] = "InternalError";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TooManyFollowings"] = 161] = "TooManyFollowings";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetLimitExceeded"] = 185] = "TweetLimitExceeded";
  EApiV1ErrorCode2[EApiV1ErrorCode2["DuplicatedTweet"] = 187] = "DuplicatedTweet";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TooManySpamReports"] = 205] = "TooManySpamReports";
  EApiV1ErrorCode2[EApiV1ErrorCode2["RequestLooksLikeSpam"] = 226] = "RequestLooksLikeSpam";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NoWriteRightForApp"] = 261] = "NoWriteRightForApp";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetActionsDisabled"] = 425] = "TweetActionsDisabled";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetRepliesRestricted"] = 433] = "TweetRepliesRestricted";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NamedParameterMissing"] = 38] = "NamedParameterMissing";
  EApiV1ErrorCode2[EApiV1ErrorCode2["InvalidAttachmentUrl"] = 44] = "InvalidAttachmentUrl";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetTextTooLong"] = 186] = "TweetTextTooLong";
  EApiV1ErrorCode2[EApiV1ErrorCode2["MissingUrlParameter"] = 195] = "MissingUrlParameter";
  EApiV1ErrorCode2[EApiV1ErrorCode2["NoMultipleGifs"] = 323] = "NoMultipleGifs";
  EApiV1ErrorCode2[EApiV1ErrorCode2["InvalidMediaIds"] = 324] = "InvalidMediaIds";
  EApiV1ErrorCode2[EApiV1ErrorCode2["InvalidUrl"] = 407] = "InvalidUrl";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TooManyTweetAttachments"] = 386] = "TooManyTweetAttachments";
  EApiV1ErrorCode2[EApiV1ErrorCode2["StatusAlreadyFavorited"] = 139] = "StatusAlreadyFavorited";
  EApiV1ErrorCode2[EApiV1ErrorCode2["FollowRequestAlreadySent"] = 160] = "FollowRequestAlreadySent";
  EApiV1ErrorCode2[EApiV1ErrorCode2["CannotUnmuteANonMutedAccount"] = 272] = "CannotUnmuteANonMutedAccount";
  EApiV1ErrorCode2[EApiV1ErrorCode2["TweetAlreadyRetweeted"] = 327] = "TweetAlreadyRetweeted";
  EApiV1ErrorCode2[EApiV1ErrorCode2["ReplyToDeletedTweet"] = 385] = "ReplyToDeletedTweet";
  EApiV1ErrorCode2[EApiV1ErrorCode2["DMReceiverNotFollowingYou"] = 150] = "DMReceiverNotFollowingYou";
  EApiV1ErrorCode2[EApiV1ErrorCode2["UnableToSendDM"] = 151] = "UnableToSendDM";
  EApiV1ErrorCode2[EApiV1ErrorCode2["MustAllowDMFromAnyone"] = 214] = "MustAllowDMFromAnyone";
  EApiV1ErrorCode2[EApiV1ErrorCode2["CannotSendDMToThisUser"] = 349] = "CannotSendDMToThisUser";
  EApiV1ErrorCode2[EApiV1ErrorCode2["DMTextTooLong"] = 354] = "DMTextTooLong";
  EApiV1ErrorCode2[EApiV1ErrorCode2["SubscriptionAlreadyExists"] = 355] = "SubscriptionAlreadyExists";
  EApiV1ErrorCode2[EApiV1ErrorCode2["CallbackUrlNotApproved"] = 415] = "CallbackUrlNotApproved";
  EApiV1ErrorCode2[EApiV1ErrorCode2["SuspendedApplication"] = 416] = "SuspendedApplication";
  EApiV1ErrorCode2[EApiV1ErrorCode2["OobOauthIsNotAllowed"] = 417] = "OobOauthIsNotAllowed";
})(EApiV1ErrorCode || (EApiV1ErrorCode = {}));
var EApiV2ErrorCode;
(function(EApiV2ErrorCode2) {
  EApiV2ErrorCode2["InvalidRequest"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#invalid-request";
  EApiV2ErrorCode2["ClientForbidden"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#client-forbidden";
  EApiV2ErrorCode2["UnsupportedAuthentication"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#unsupported-authentication";
  EApiV2ErrorCode2["InvalidRules"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#invalid-rules";
  EApiV2ErrorCode2["TooManyRules"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#rule-cap";
  EApiV2ErrorCode2["DuplicatedRules"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#duplicate-rules";
  EApiV2ErrorCode2["RateLimitExceeded"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#usage-capped";
  EApiV2ErrorCode2["ConnectionError"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#streaming-connection";
  EApiV2ErrorCode2["ClientDisconnected"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#client-disconnected";
  EApiV2ErrorCode2["TwitterDisconnectedYou"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#operational-disconnect";
  EApiV2ErrorCode2["ResourceNotFound"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#resource-not-found";
  EApiV2ErrorCode2["ResourceUnauthorized"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#not-authorized-for-resource";
  EApiV2ErrorCode2["DisallowedResource"] = "https://developer.x.com/en/support/x-api/error-troubleshooting#disallowed-resource";
})(EApiV2ErrorCode || (EApiV2ErrorCode = {}));
// node_modules/twitter-api-v2/dist/esm/types/client.types.js
var ETwitterStreamEvent;
(function(ETwitterStreamEvent2) {
  ETwitterStreamEvent2["Connected"] = "connected";
  ETwitterStreamEvent2["ConnectError"] = "connect error";
  ETwitterStreamEvent2["ConnectionError"] = "connection error";
  ETwitterStreamEvent2["ConnectionClosed"] = "connection closed";
  ETwitterStreamEvent2["ConnectionLost"] = "connection lost";
  ETwitterStreamEvent2["ReconnectAttempt"] = "reconnect attempt";
  ETwitterStreamEvent2["Reconnected"] = "reconnected";
  ETwitterStreamEvent2["ReconnectError"] = "reconnect error";
  ETwitterStreamEvent2["ReconnectLimitExceeded"] = "reconnect limit exceeded";
  ETwitterStreamEvent2["DataKeepAlive"] = "data keep-alive";
  ETwitterStreamEvent2["Data"] = "data event content";
  ETwitterStreamEvent2["DataError"] = "data twitter error";
  ETwitterStreamEvent2["TweetParseError"] = "data tweet parse error";
  ETwitterStreamEvent2["Error"] = "stream error";
})(ETwitterStreamEvent || (ETwitterStreamEvent = {}));
// node_modules/twitter-api-v2/dist/esm/types/plugins/client.plugins.types.js
class TwitterApiPluginResponseOverride {
  constructor(value) {
    this.value = value;
  }
}
// node_modules/twitter-api-v2/dist/esm/v1/client.v1.write.js
import * as fs2 from "fs";

// node_modules/twitter-api-v2/dist/esm/settings.js
var TwitterApiV2Settings = {
  debug: false,
  deprecationWarnings: true,
  logger: { log: console.log.bind(console) }
};

// node_modules/twitter-api-v2/dist/esm/helpers.js
function sharedPromise(getter) {
  const sharedPromise2 = {
    value: undefined,
    promise: getter().then((val) => {
      sharedPromise2.value = val;
      return val;
    })
  };
  return sharedPromise2;
}
function arrayWrap(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}
function trimUndefinedProperties(object) {
  for (const parameter of Object.keys(object)) {
    if (object[parameter] === undefined) {
      delete object[parameter];
    }
  }
}
function isTweetStreamV2ErrorPayload(payload) {
  return typeof payload === "object" && "errors" in payload && !("data" in payload);
}
function hasMultipleItems(item) {
  if (Array.isArray(item) && item.length > 1) {
    return true;
  }
  return item.toString().includes(",");
}
var deprecationWarningsCache = new Set;
function safeDeprecationWarning(message) {
  if (typeof console === "undefined" || !console.warn || !TwitterApiV2Settings.deprecationWarnings) {
    return;
  }
  const hash = `${message.instance}-${message.method}-${message.problem}`;
  if (deprecationWarningsCache.has(hash)) {
    return;
  }
  const formattedMsg = `[twitter-api-v2] Deprecation warning: In ${message.instance}.${message.method}() call` + `, ${message.problem}.
${message.resolution}.`;
  console.warn(formattedMsg);
  console.warn("To disable this message, import variable TwitterApiV2Settings from twitter-api-v2 and set TwitterApiV2Settings.deprecationWarnings to false.");
  deprecationWarningsCache.add(hash);
}

// node_modules/twitter-api-v2/dist/esm/stream/TweetStream.js
import { EventEmitter as EventEmitter4 } from "events";

// node_modules/twitter-api-v2/dist/esm/client-mixins/request-handler.helper.js
import { request } from "https";
import * as zlib from "zlib";
import { EventEmitter } from "events";

class RequestHandlerHelper {
  constructor(requestData) {
    this.requestData = requestData;
    this.requestErrorHandled = false;
    this.responseData = [];
  }
  get hrefPathname() {
    const url = this.requestData.url;
    return url.hostname + url.pathname;
  }
  isCompressionDisabled() {
    return !this.requestData.compression || this.requestData.compression === "identity";
  }
  isFormEncodedEndpoint() {
    return this.requestData.url.href.startsWith("https://api.x.com/oauth/");
  }
  createRequestError(error) {
    if (TwitterApiV2Settings.debug) {
      TwitterApiV2Settings.logger.log("Request error:", error);
    }
    return new ApiRequestError("Request failed.", {
      request: this.req,
      error
    });
  }
  createPartialResponseError(error, abortClose) {
    const res = this.res;
    let message = `Request failed with partial response with HTTP code ${res.statusCode}`;
    if (abortClose) {
      message += " (connection abruptly closed)";
    } else {
      message += " (parse error)";
    }
    return new ApiPartialResponseError(message, {
      request: this.req,
      response: this.res,
      responseError: error,
      rawContent: Buffer.concat(this.responseData).toString()
    });
  }
  formatV1Errors(errors2) {
    return errors2.map(({ code, message }) => `${message} (Twitter code ${code})`).join(", ");
  }
  formatV2Error(error) {
    return `${error.title}: ${error.detail} (see ${error.type})`;
  }
  createResponseError({ res, data, rateLimit, code }) {
    var _a;
    if (TwitterApiV2Settings.debug) {
      TwitterApiV2Settings.logger.log(`Request failed with code ${code}, data:`, data);
      TwitterApiV2Settings.logger.log("Response headers:", res.headers);
    }
    let errorString = `Request failed with code ${code}`;
    if ((_a = data === null || data === undefined ? undefined : data.errors) === null || _a === undefined ? undefined : _a.length) {
      const errors2 = data.errors;
      if (typeof errors2[0] === "object" && "code" in errors2[0]) {
        errorString += " - " + this.formatV1Errors(errors2);
      } else {
        errorString += " - " + this.formatV2Error(data);
      }
    }
    return new ApiResponseError(errorString, {
      code,
      data,
      headers: res.headers,
      request: this.req,
      response: res,
      rateLimit
    });
  }
  getResponseDataStream(res) {
    if (this.isCompressionDisabled()) {
      return res;
    }
    const contentEncoding = (res.headers["content-encoding"] || "identity").trim().toLowerCase();
    if (contentEncoding === "br") {
      const brotli = zlib.createBrotliDecompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
      });
      res.pipe(brotli);
      return brotli;
    }
    if (contentEncoding === "gzip") {
      const gunzip = zlib.createGunzip({
        flush: zlib.constants.Z_SYNC_FLUSH,
        finishFlush: zlib.constants.Z_SYNC_FLUSH
      });
      res.pipe(gunzip);
      return gunzip;
    }
    if (contentEncoding === "deflate") {
      const inflate = zlib.createInflate({
        flush: zlib.constants.Z_SYNC_FLUSH,
        finishFlush: zlib.constants.Z_SYNC_FLUSH
      });
      res.pipe(inflate);
      return inflate;
    }
    return res;
  }
  detectResponseType(res) {
    var _a, _b;
    if (((_a = res.headers["content-type"]) === null || _a === undefined ? undefined : _a.includes("application/json")) || ((_b = res.headers["content-type"]) === null || _b === undefined ? undefined : _b.includes("application/problem+json"))) {
      return "json";
    } else if (this.isFormEncodedEndpoint()) {
      return "url";
    }
    return "text";
  }
  getParsedResponse(res) {
    const data = this.responseData;
    const mode = this.requestData.forceParseMode || this.detectResponseType(res);
    if (mode === "buffer") {
      return Buffer.concat(data);
    } else if (mode === "text") {
      return Buffer.concat(data).toString();
    } else if (mode === "json") {
      const asText = Buffer.concat(data).toString();
      return asText.length ? JSON.parse(asText) : undefined;
    } else if (mode === "url") {
      const asText = Buffer.concat(data).toString();
      const formEntries = {};
      for (const [item, value] of new URLSearchParams(asText)) {
        formEntries[item] = value;
      }
      return formEntries;
    } else {
      return;
    }
  }
  getRateLimitFromResponse(res) {
    let rateLimit = undefined;
    if (res.headers["x-rate-limit-limit"]) {
      rateLimit = {
        limit: Number(res.headers["x-rate-limit-limit"]),
        remaining: Number(res.headers["x-rate-limit-remaining"]),
        reset: Number(res.headers["x-rate-limit-reset"])
      };
      if (res.headers["x-app-limit-24hour-limit"]) {
        rateLimit.day = {
          limit: Number(res.headers["x-app-limit-24hour-limit"]),
          remaining: Number(res.headers["x-app-limit-24hour-remaining"]),
          reset: Number(res.headers["x-app-limit-24hour-reset"])
        };
      }
      if (res.headers["x-user-limit-24hour-limit"]) {
        rateLimit.userDay = {
          limit: Number(res.headers["x-user-limit-24hour-limit"]),
          remaining: Number(res.headers["x-user-limit-24hour-remaining"]),
          reset: Number(res.headers["x-user-limit-24hour-reset"])
        };
      }
      if (this.requestData.rateLimitSaver) {
        this.requestData.rateLimitSaver(rateLimit);
      }
    }
    return rateLimit;
  }
  onSocketEventHandler(reject, cleanupListener, socket) {
    const onClose = this.onSocketCloseHandler.bind(this, reject);
    socket.on("close", onClose);
    cleanupListener.on("complete", () => socket.off("close", onClose));
  }
  onSocketCloseHandler(reject) {
    this.req.removeAllListeners("timeout");
    const res = this.res;
    if (res) {
      return;
    }
    if (!this.requestErrorHandled) {
      return reject(this.createRequestError(new Error("Socket closed without any information.")));
    }
  }
  requestErrorHandler(reject, requestError) {
    var _a, _b;
    (_b = (_a = this.requestData).requestEventDebugHandler) === null || _b === undefined || _b.call(_a, "request-error", { requestError });
    this.requestErrorHandled = true;
    reject(this.createRequestError(requestError));
  }
  timeoutErrorHandler() {
    this.requestErrorHandled = true;
    this.req.destroy(new Error("Request timeout."));
  }
  classicResponseHandler(resolve, reject, res) {
    this.res = res;
    const dataStream = this.getResponseDataStream(res);
    dataStream.on("data", (chunk) => this.responseData.push(chunk));
    dataStream.on("end", this.onResponseEndHandler.bind(this, resolve, reject));
    dataStream.on("close", this.onResponseCloseHandler.bind(this, resolve, reject));
    if (this.requestData.requestEventDebugHandler) {
      this.requestData.requestEventDebugHandler("response", { res });
      res.on("aborted", (error) => this.requestData.requestEventDebugHandler("response-aborted", { error }));
      res.on("error", (error) => this.requestData.requestEventDebugHandler("response-error", { error }));
      res.on("close", () => this.requestData.requestEventDebugHandler("response-close", { data: this.responseData }));
      res.on("end", () => this.requestData.requestEventDebugHandler("response-end"));
    }
  }
  onResponseEndHandler(resolve, reject) {
    const rateLimit = this.getRateLimitFromResponse(this.res);
    let data;
    try {
      data = this.getParsedResponse(this.res);
    } catch (e) {
      reject(this.createPartialResponseError(e, false));
      return;
    }
    const code = this.res.statusCode;
    if (code >= 400) {
      reject(this.createResponseError({ data, res: this.res, rateLimit, code }));
      return;
    }
    if (TwitterApiV2Settings.debug) {
      TwitterApiV2Settings.logger.log(`[${this.requestData.options.method} ${this.hrefPathname}]: Request succeeds with code ${this.res.statusCode}`);
      TwitterApiV2Settings.logger.log("Response body:", data);
    }
    resolve({
      data,
      headers: this.res.headers,
      rateLimit
    });
  }
  onResponseCloseHandler(resolve, reject) {
    const res = this.res;
    if (res.aborted) {
      try {
        this.getParsedResponse(this.res);
        return this.onResponseEndHandler(resolve, reject);
      } catch (e) {
        return reject(this.createPartialResponseError(e, true));
      }
    }
    if (!res.complete) {
      return reject(this.createPartialResponseError(new Error("Response has been interrupted before response could be parsed."), true));
    }
  }
  streamResponseHandler(resolve, reject, res) {
    const code = res.statusCode;
    if (code < 400) {
      if (TwitterApiV2Settings.debug) {
        TwitterApiV2Settings.logger.log(`[${this.requestData.options.method} ${this.hrefPathname}]: Request succeeds with code ${res.statusCode} (starting stream)`);
      }
      const dataStream = this.getResponseDataStream(res);
      resolve({ req: this.req, res: dataStream, originalResponse: res, requestData: this.requestData });
    } else {
      this.classicResponseHandler(() => {
        return;
      }, reject, res);
    }
  }
  debugRequest() {
    const url = this.requestData.url;
    TwitterApiV2Settings.logger.log(`[${this.requestData.options.method} ${this.hrefPathname}]`, this.requestData.options);
    if (url.search) {
      TwitterApiV2Settings.logger.log("Request parameters:", [...url.searchParams.entries()].map(([key, value]) => `${key}: ${value}`));
    }
    if (this.requestData.body) {
      TwitterApiV2Settings.logger.log("Request body:", this.requestData.body);
    }
  }
  buildRequest() {
    var _a;
    const url = this.requestData.url;
    const auth2 = url.username ? `${url.username}:${url.password}` : undefined;
    const headers = (_a = this.requestData.options.headers) !== null && _a !== undefined ? _a : {};
    if (this.requestData.compression === true || this.requestData.compression === "brotli") {
      headers["accept-encoding"] = "br;q=1.0, gzip;q=0.8, deflate;q=0.5, *;q=0.1";
    } else if (this.requestData.compression === "gzip") {
      headers["accept-encoding"] = "gzip;q=1, deflate;q=0.5, *;q=0.1";
    } else if (this.requestData.compression === "deflate") {
      headers["accept-encoding"] = "deflate;q=1, *;q=0.1";
    }
    if (TwitterApiV2Settings.debug) {
      this.debugRequest();
    }
    this.req = request({
      ...this.requestData.options,
      host: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      protocol: url.protocol,
      auth: auth2,
      headers
    });
  }
  registerRequestEventDebugHandlers(req) {
    req.on("close", () => this.requestData.requestEventDebugHandler("close"));
    req.on("abort", () => this.requestData.requestEventDebugHandler("abort"));
    req.on("socket", (socket) => {
      this.requestData.requestEventDebugHandler("socket", { socket });
      socket.on("error", (error) => this.requestData.requestEventDebugHandler("socket-error", { socket, error }));
      socket.on("connect", () => this.requestData.requestEventDebugHandler("socket-connect", { socket }));
      socket.on("close", (withError) => this.requestData.requestEventDebugHandler("socket-close", { socket, withError }));
      socket.on("end", () => this.requestData.requestEventDebugHandler("socket-end", { socket }));
      socket.on("lookup", (...data) => this.requestData.requestEventDebugHandler("socket-lookup", { socket, data }));
      socket.on("timeout", () => this.requestData.requestEventDebugHandler("socket-timeout", { socket }));
    });
  }
  makeRequest() {
    this.buildRequest();
    return new Promise((_resolve, _reject) => {
      const resolve = (value) => {
        cleanupListener.emit("complete");
        _resolve(value);
      };
      const reject = (value) => {
        cleanupListener.emit("complete");
        _reject(value);
      };
      const cleanupListener = new EventEmitter;
      const req = this.req;
      req.on("error", this.requestErrorHandler.bind(this, reject));
      req.on("socket", this.onSocketEventHandler.bind(this, reject, cleanupListener));
      req.on("response", this.classicResponseHandler.bind(this, resolve, reject));
      if (this.requestData.options.timeout) {
        req.on("timeout", this.timeoutErrorHandler.bind(this));
      }
      if (this.requestData.requestEventDebugHandler) {
        this.registerRequestEventDebugHandlers(req);
      }
      if (this.requestData.body) {
        req.write(this.requestData.body);
      }
      req.end();
    });
  }
  async makeRequestAsStream() {
    const { req, res, requestData, originalResponse } = await this.makeRequestAndResolveWhenReady();
    return new TweetStream_default(requestData, { req, res, originalResponse });
  }
  makeRequestAndResolveWhenReady() {
    this.buildRequest();
    return new Promise((resolve, reject) => {
      const req = this.req;
      req.on("error", this.requestErrorHandler.bind(this, reject));
      req.on("response", this.streamResponseHandler.bind(this, resolve, reject));
      if (this.requestData.body) {
        req.write(this.requestData.body);
      }
      req.end();
    });
  }
}
var request_handler_helper_default = RequestHandlerHelper;

// node_modules/twitter-api-v2/dist/esm/stream/TweetStreamEventCombiner.js
import { EventEmitter as EventEmitter2 } from "events";
class TweetStreamEventCombiner extends EventEmitter2 {
  constructor(stream) {
    super();
    this.stream = stream;
    this.stack = [];
    this.onStreamData = this.onStreamData.bind(this);
    this.onStreamError = this.onStreamError.bind(this);
    this.onceNewEvent = this.once.bind(this, "event");
    stream.on(ETwitterStreamEvent.Data, this.onStreamData);
    stream.on(ETwitterStreamEvent.ConnectionError, this.onStreamError);
    stream.on(ETwitterStreamEvent.TweetParseError, this.onStreamError);
    stream.on(ETwitterStreamEvent.ConnectionClosed, this.onStreamError);
  }
  nextEvent() {
    return new Promise(this.onceNewEvent);
  }
  hasStack() {
    return this.stack.length > 0;
  }
  popStack() {
    const stack = this.stack;
    this.stack = [];
    return stack;
  }
  destroy() {
    this.removeAllListeners();
    this.stream.off(ETwitterStreamEvent.Data, this.onStreamData);
    this.stream.off(ETwitterStreamEvent.ConnectionError, this.onStreamError);
    this.stream.off(ETwitterStreamEvent.TweetParseError, this.onStreamError);
    this.stream.off(ETwitterStreamEvent.ConnectionClosed, this.onStreamError);
  }
  emitEvent(type, payload) {
    this.emit("event", { type, payload });
  }
  onStreamError(payload) {
    this.emitEvent("error", payload);
  }
  onStreamData(payload) {
    this.stack.push(payload);
    this.emitEvent("data", payload);
  }
}
var TweetStreamEventCombiner_default = TweetStreamEventCombiner;

// node_modules/twitter-api-v2/dist/esm/stream/TweetStreamParser.js
import { EventEmitter as EventEmitter3 } from "events";

class TweetStreamParser extends EventEmitter3 {
  constructor() {
    super(...arguments);
    this.currentMessage = "";
  }
  push(chunk) {
    this.currentMessage += chunk;
    chunk = this.currentMessage;
    const size = chunk.length;
    let start = 0;
    let offset = 0;
    while (offset < size) {
      if (chunk.slice(offset, offset + 2) === `\r
`) {
        const piece = chunk.slice(start, offset);
        start = offset += 2;
        if (!piece.length) {
          continue;
        }
        try {
          const payload = JSON.parse(piece);
          if (payload) {
            this.emit(EStreamParserEvent.ParsedData, payload);
            continue;
          }
        } catch (error) {
          this.emit(EStreamParserEvent.ParseError, error);
        }
      }
      offset++;
    }
    this.currentMessage = chunk.slice(start, size);
  }
  reset() {
    this.currentMessage = "";
  }
}
var EStreamParserEvent;
(function(EStreamParserEvent2) {
  EStreamParserEvent2["ParsedData"] = "parsed data";
  EStreamParserEvent2["ParseError"] = "parse error";
})(EStreamParserEvent || (EStreamParserEvent = {}));

// node_modules/twitter-api-v2/dist/esm/stream/TweetStream.js
var basicRetriesAttempt = [5, 15, 30, 60, 90, 120, 180, 300, 600, 900];
var basicReconnectRetry = (tryOccurrence) => tryOccurrence > basicRetriesAttempt.length ? 901000 : basicRetriesAttempt[tryOccurrence - 1] * 1000;

class TweetStream extends EventEmitter4 {
  constructor(requestData, connection) {
    super();
    this.requestData = requestData;
    this.autoReconnect = false;
    this.autoReconnectRetries = 5;
    this.keepAliveTimeoutMs = 1000 * 120;
    this.nextRetryTimeout = basicReconnectRetry;
    this.parser = new TweetStreamParser;
    this.connectionProcessRunning = false;
    this.onKeepAliveTimeout = this.onKeepAliveTimeout.bind(this);
    this.initEventsFromParser();
    if (connection) {
      this.req = connection.req;
      this.res = connection.res;
      this.originalResponse = connection.originalResponse;
      this.initEventsFromRequest();
    }
  }
  on(event, handler) {
    return super.on(event, handler);
  }
  initEventsFromRequest() {
    if (!this.req || !this.res) {
      throw new Error("TweetStream error: You cannot init TweetStream without a request and response object.");
    }
    const errorHandler = (err) => {
      this.emit(ETwitterStreamEvent.ConnectionError, err);
      this.emit(ETwitterStreamEvent.Error, {
        type: ETwitterStreamEvent.ConnectionError,
        error: err,
        message: "Connection lost or closed by Twitter."
      });
      this.onConnectionError();
    };
    this.req.on("error", errorHandler);
    this.res.on("error", errorHandler);
    this.res.on("close", () => errorHandler(new Error("Connection closed by Twitter.")));
    this.res.on("data", (chunk) => {
      this.resetKeepAliveTimeout();
      if (chunk.toString() === `\r
`) {
        return this.emit(ETwitterStreamEvent.DataKeepAlive);
      }
      this.parser.push(chunk.toString());
    });
    this.resetKeepAliveTimeout();
  }
  initEventsFromParser() {
    const payloadIsError = this.requestData.payloadIsError;
    this.parser.on(EStreamParserEvent.ParsedData, (eventData) => {
      if (payloadIsError && payloadIsError(eventData)) {
        this.emit(ETwitterStreamEvent.DataError, eventData);
        this.emit(ETwitterStreamEvent.Error, {
          type: ETwitterStreamEvent.DataError,
          error: eventData,
          message: "Twitter sent a payload that is detected as an error payload."
        });
      } else {
        this.emit(ETwitterStreamEvent.Data, eventData);
      }
    });
    this.parser.on(EStreamParserEvent.ParseError, (error) => {
      this.emit(ETwitterStreamEvent.TweetParseError, error);
      this.emit(ETwitterStreamEvent.Error, {
        type: ETwitterStreamEvent.TweetParseError,
        error,
        message: "Failed to parse stream data."
      });
    });
  }
  resetKeepAliveTimeout() {
    this.unbindKeepAliveTimeout();
    if (this.keepAliveTimeoutMs !== Infinity) {
      this.keepAliveTimeout = setTimeout(this.onKeepAliveTimeout, this.keepAliveTimeoutMs);
    }
  }
  onKeepAliveTimeout() {
    this.emit(ETwitterStreamEvent.ConnectionLost);
    this.onConnectionError();
  }
  unbindTimeouts() {
    this.unbindRetryTimeout();
    this.unbindKeepAliveTimeout();
  }
  unbindKeepAliveTimeout() {
    if (this.keepAliveTimeout) {
      clearTimeout(this.keepAliveTimeout);
      this.keepAliveTimeout = undefined;
    }
  }
  unbindRetryTimeout() {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = undefined;
    }
  }
  closeWithoutEmit() {
    this.unbindTimeouts();
    if (this.res) {
      this.res.removeAllListeners();
      this.res.destroy();
    }
    if (this.req) {
      this.req.removeAllListeners();
      this.req.destroy();
    }
  }
  close() {
    this.emit(ETwitterStreamEvent.ConnectionClosed);
    this.closeWithoutEmit();
  }
  destroy() {
    this.removeAllListeners();
    this.close();
  }
  async clone() {
    const newRequest = new request_handler_helper_default(this.requestData);
    const newStream = await newRequest.makeRequestAsStream();
    const listenerNames = this.eventNames();
    for (const listener of listenerNames) {
      const callbacks = this.listeners(listener);
      for (const callback of callbacks) {
        newStream.on(listener, callback);
      }
    }
    return newStream;
  }
  async connect(options = {}) {
    if (typeof options.autoReconnect !== "undefined") {
      this.autoReconnect = options.autoReconnect;
    }
    if (typeof options.autoReconnectRetries !== "undefined") {
      this.autoReconnectRetries = options.autoReconnectRetries === "unlimited" ? Infinity : options.autoReconnectRetries;
    }
    if (typeof options.keepAliveTimeout !== "undefined") {
      this.keepAliveTimeoutMs = options.keepAliveTimeout === "disable" ? Infinity : options.keepAliveTimeout;
    }
    if (typeof options.nextRetryTimeout !== "undefined") {
      this.nextRetryTimeout = options.nextRetryTimeout;
    }
    this.unbindTimeouts();
    try {
      await this.reconnect();
    } catch (e) {
      this.emit(ETwitterStreamEvent.ConnectError, 0);
      this.emit(ETwitterStreamEvent.Error, {
        type: ETwitterStreamEvent.ConnectError,
        error: e,
        message: "Connect error - Initial connection just failed."
      });
      if (this.autoReconnect) {
        this.makeAutoReconnectRetry(0, e);
      } else {
        throw e;
      }
    }
    return this;
  }
  async reconnect() {
    if (this.connectionProcessRunning) {
      throw new Error("Connection process is already running.");
    }
    this.connectionProcessRunning = true;
    try {
      let initialConnection = true;
      if (this.req) {
        initialConnection = false;
        this.closeWithoutEmit();
      }
      const { req, res, originalResponse } = await new request_handler_helper_default(this.requestData).makeRequestAndResolveWhenReady();
      this.req = req;
      this.res = res;
      this.originalResponse = originalResponse;
      this.emit(initialConnection ? ETwitterStreamEvent.Connected : ETwitterStreamEvent.Reconnected);
      this.parser.reset();
      this.initEventsFromRequest();
    } finally {
      this.connectionProcessRunning = false;
    }
  }
  async onConnectionError(retryOccurrence = 0) {
    this.unbindTimeouts();
    this.closeWithoutEmit();
    if (!this.autoReconnect) {
      this.emit(ETwitterStreamEvent.ConnectionClosed);
      return;
    }
    if (retryOccurrence >= this.autoReconnectRetries) {
      this.emit(ETwitterStreamEvent.ReconnectLimitExceeded);
      this.emit(ETwitterStreamEvent.ConnectionClosed);
      return;
    }
    try {
      this.emit(ETwitterStreamEvent.ReconnectAttempt, retryOccurrence);
      await this.reconnect();
    } catch (e) {
      this.emit(ETwitterStreamEvent.ReconnectError, retryOccurrence);
      this.emit(ETwitterStreamEvent.Error, {
        type: ETwitterStreamEvent.ReconnectError,
        error: e,
        message: `Reconnect error - ${retryOccurrence + 1} attempts made yet.`
      });
      this.makeAutoReconnectRetry(retryOccurrence, e);
    }
  }
  makeAutoReconnectRetry(retryOccurrence, error) {
    const nextRetry = this.nextRetryTimeout(retryOccurrence + 1, error);
    this.retryTimeout = setTimeout(() => {
      this.onConnectionError(retryOccurrence + 1);
    }, nextRetry);
  }
  async* [Symbol.asyncIterator]() {
    const eventCombiner = new TweetStreamEventCombiner_default(this);
    try {
      while (true) {
        if (!this.req || this.req.aborted) {
          throw new Error("Connection closed");
        }
        if (eventCombiner.hasStack()) {
          yield* eventCombiner.popStack();
        }
        const { type, payload } = await eventCombiner.nextEvent();
        if (type === "error") {
          throw payload;
        }
      }
    } finally {
      eventCombiner.destroy();
    }
  }
}
var TweetStream_default = TweetStream;

// node_modules/twitter-api-v2/dist/esm/plugins/helpers.js
function hasRequestErrorPlugins(client2) {
  var _a;
  if (!((_a = client2.clientSettings.plugins) === null || _a === undefined ? undefined : _a.length)) {
    return false;
  }
  for (const plugin of client2.clientSettings.plugins) {
    if (plugin.onRequestError || plugin.onResponseError) {
      return true;
    }
  }
  return false;
}
async function applyResponseHooks(requestParams, computedParams, requestOptions, error) {
  let override;
  if (error instanceof ApiRequestError || error instanceof ApiPartialResponseError) {
    override = await this.applyPluginMethod("onRequestError", {
      client: this,
      url: this.getUrlObjectFromUrlString(requestParams.url),
      params: requestParams,
      computedParams,
      requestOptions,
      error
    });
  } else if (error instanceof ApiResponseError) {
    override = await this.applyPluginMethod("onResponseError", {
      client: this,
      url: this.getUrlObjectFromUrlString(requestParams.url),
      params: requestParams,
      computedParams,
      requestOptions,
      error
    });
  }
  if (override && override instanceof TwitterApiPluginResponseOverride) {
    return override.value;
  }
  return Promise.reject(error);
}

// node_modules/twitter-api-v2/dist/esm/client-mixins/oauth1.helper.js
import * as crypto from "crypto";

class OAuth1Helper {
  constructor(options) {
    this.nonceLength = 32;
    this.consumerKeys = options.consumerKeys;
  }
  static percentEncode(str) {
    return encodeURIComponent(str).replace(/!/g, "%21").replace(/\*/g, "%2A").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
  }
  hash(base, key) {
    return crypto.createHmac("sha1", key).update(base).digest("base64");
  }
  authorize(request2, accessTokens = {}) {
    const oauthInfo = {
      oauth_consumer_key: this.consumerKeys.key,
      oauth_nonce: this.getNonce(),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: this.getTimestamp(),
      oauth_version: "1.0"
    };
    if (accessTokens.key !== undefined) {
      oauthInfo.oauth_token = accessTokens.key;
    }
    if (!request2.data) {
      request2.data = {};
    }
    oauthInfo.oauth_signature = this.getSignature(request2, accessTokens.secret, oauthInfo);
    return oauthInfo;
  }
  toHeader(oauthInfo) {
    const sorted = sortObject(oauthInfo);
    let header_value = "OAuth ";
    for (const element of sorted) {
      if (element.key.indexOf("oauth_") !== 0) {
        continue;
      }
      header_value += OAuth1Helper.percentEncode(element.key) + '="' + OAuth1Helper.percentEncode(element.value) + '",';
    }
    return {
      Authorization: header_value.slice(0, header_value.length - 1)
    };
  }
  getNonce() {
    const wordCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0;i < this.nonceLength; i++) {
      result += wordCharacters[Math.trunc(Math.random() * wordCharacters.length)];
    }
    return result;
  }
  getTimestamp() {
    return Math.trunc(new Date().getTime() / 1000);
  }
  getSignature(request2, tokenSecret, oauthInfo) {
    return this.hash(this.getBaseString(request2, oauthInfo), this.getSigningKey(tokenSecret));
  }
  getSigningKey(tokenSecret) {
    return OAuth1Helper.percentEncode(this.consumerKeys.secret) + "&" + OAuth1Helper.percentEncode(tokenSecret || "");
  }
  getBaseString(request2, oauthInfo) {
    return request2.method.toUpperCase() + "&" + OAuth1Helper.percentEncode(this.getBaseUrl(request2.url)) + "&" + OAuth1Helper.percentEncode(this.getParameterString(request2, oauthInfo));
  }
  getParameterString(request2, oauthInfo) {
    const baseStringData = sortObject(percentEncodeData(mergeObject(oauthInfo, mergeObject(request2.data, deParamUrl(request2.url)))));
    let dataStr = "";
    for (const { key, value } of baseStringData) {
      if (value && Array.isArray(value)) {
        value.sort();
        let valString = "";
        value.forEach((item, i) => {
          valString += key + "=" + item;
          if (i < value.length) {
            valString += "&";
          }
        });
        dataStr += valString;
      } else {
        dataStr += key + "=" + value + "&";
      }
    }
    return dataStr.slice(0, dataStr.length - 1);
  }
  getBaseUrl(url) {
    return url.split("?")[0];
  }
}
var oauth1_helper_default = OAuth1Helper;
function mergeObject(obj1, obj2) {
  return {
    ...obj1 || {},
    ...obj2 || {}
  };
}
function sortObject(data) {
  return Object.keys(data).sort().map((key) => ({ key, value: data[key] }));
}
function deParam(string) {
  const split = string.split("&");
  const data = {};
  for (const coupleKeyValue of split) {
    const [key, value = ""] = coupleKeyValue.split("=");
    if (data[key]) {
      if (!Array.isArray(data[key])) {
        data[key] = [data[key]];
      }
      data[key].push(decodeURIComponent(value));
    } else {
      data[key] = decodeURIComponent(value);
    }
  }
  return data;
}
function deParamUrl(url) {
  const tmp = url.split("?");
  if (tmp.length === 1)
    return {};
  return deParam(tmp[1]);
}
function percentEncodeData(data) {
  const result = {};
  for (const key in data) {
    let value = data[key];
    if (value && Array.isArray(value)) {
      value = value.map((v) => OAuth1Helper.percentEncode(v));
    } else {
      value = OAuth1Helper.percentEncode(value);
    }
    result[OAuth1Helper.percentEncode(key)] = value;
  }
  return result;
}

// node_modules/twitter-api-v2/dist/esm/client-mixins/form-data.helper.js
class FormDataHelper {
  constructor() {
    this._boundary = "";
    this._chunks = [];
  }
  bodyAppend(...values) {
    const allAsBuffer = values.map((val) => val instanceof Buffer ? val : Buffer.from(val));
    this._chunks.push(...allAsBuffer);
  }
  append(field, value, contentType) {
    const convertedValue = value instanceof Buffer ? value : value.toString();
    const header = this.getMultipartHeader(field, convertedValue, contentType);
    this.bodyAppend(header, convertedValue, FormDataHelper.LINE_BREAK);
  }
  getHeaders() {
    return {
      "content-type": "multipart/form-data; boundary=" + this.getBoundary()
    };
  }
  getLength() {
    return this._chunks.reduce((acc, cur) => acc + cur.length, this.getMultipartFooter().length);
  }
  getBuffer() {
    const allChunks = [...this._chunks, this.getMultipartFooter()];
    const totalBuffer = Buffer.alloc(this.getLength());
    let i = 0;
    for (const chunk of allChunks) {
      for (let j = 0;j < chunk.length; i++, j++) {
        totalBuffer[i] = chunk[j];
      }
    }
    return totalBuffer;
  }
  getBoundary() {
    if (!this._boundary) {
      this.generateBoundary();
    }
    return this._boundary;
  }
  generateBoundary() {
    let boundary = "--------------------------";
    for (let i = 0;i < 24; i++) {
      boundary += Math.floor(Math.random() * 10).toString(16);
    }
    this._boundary = boundary;
  }
  getMultipartHeader(field, value, contentType) {
    if (!contentType) {
      contentType = value instanceof Buffer ? FormDataHelper.DEFAULT_CONTENT_TYPE : "";
    }
    const headers = {
      "Content-Disposition": ["form-data", `name="${field}"`],
      "Content-Type": contentType
    };
    let contents = "";
    for (const [prop, header] of Object.entries(headers)) {
      if (!header.length) {
        continue;
      }
      contents += prop + ": " + arrayWrap(header).join("; ") + FormDataHelper.LINE_BREAK;
    }
    return "--" + this.getBoundary() + FormDataHelper.LINE_BREAK + contents + FormDataHelper.LINE_BREAK;
  }
  getMultipartFooter() {
    if (this._footerChunk) {
      return this._footerChunk;
    }
    return this._footerChunk = Buffer.from("--" + this.getBoundary() + "--" + FormDataHelper.LINE_BREAK);
  }
}
FormDataHelper.LINE_BREAK = `\r
`;
FormDataHelper.DEFAULT_CONTENT_TYPE = "application/octet-stream";

// node_modules/twitter-api-v2/dist/esm/client-mixins/request-param.helper.js
class RequestParamHelpers {
  static formatQueryToString(query) {
    const formattedQuery = {};
    for (const prop in query) {
      if (typeof query[prop] === "string") {
        formattedQuery[prop] = query[prop];
      } else if (typeof query[prop] !== "undefined") {
        formattedQuery[prop] = String(query[prop]);
      }
    }
    return formattedQuery;
  }
  static autoDetectBodyType(url) {
    if (url.pathname.startsWith("/2/") || url.pathname.startsWith("/labs/2/")) {
      if (url.password.startsWith("/2/oauth2")) {
        return "url";
      }
      return "json";
    }
    if (url.hostname === "upload.x.com") {
      if (url.pathname === "/1.1/media/upload.json") {
        return "form-data";
      }
      return "json";
    }
    const endpoint = url.pathname.split("/1.1/", 2)[1];
    if (this.JSON_1_1_ENDPOINTS.has(endpoint)) {
      return "json";
    }
    return "url";
  }
  static addQueryParamsToUrl(url, query) {
    const queryEntries = Object.entries(query);
    if (queryEntries.length) {
      let search = "";
      for (const [key, value] of queryEntries) {
        search += (search.length ? "&" : "?") + `${oauth1_helper_default.percentEncode(key)}=${oauth1_helper_default.percentEncode(value)}`;
      }
      url.search = search;
    }
  }
  static constructBodyParams(body, headers, mode) {
    if (body instanceof Buffer) {
      return body;
    }
    if (mode === "json") {
      if (!headers["content-type"]) {
        headers["content-type"] = "application/json;charset=UTF-8";
      }
      return JSON.stringify(body);
    } else if (mode === "url") {
      if (!headers["content-type"]) {
        headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
      }
      if (Object.keys(body).length) {
        return new URLSearchParams(body).toString().replace(/\*/g, "%2A");
      }
      return "";
    } else if (mode === "raw") {
      throw new Error("You can only use raw body mode with Buffers. To give a string, use Buffer.from(str).");
    } else {
      const form = new FormDataHelper;
      for (const parameter in body) {
        form.append(parameter, body[parameter]);
      }
      if (!headers["content-type"]) {
        const formHeaders = form.getHeaders();
        headers["content-type"] = formHeaders["content-type"];
      }
      return form.getBuffer();
    }
  }
  static setBodyLengthHeader(options, body) {
    var _a;
    options.headers = (_a = options.headers) !== null && _a !== undefined ? _a : {};
    if (typeof body === "string") {
      options.headers["content-length"] = Buffer.byteLength(body);
    } else {
      options.headers["content-length"] = body.length;
    }
  }
  static isOAuthSerializable(item) {
    return !(item instanceof Buffer);
  }
  static mergeQueryAndBodyForOAuth(query, body) {
    const parameters = {};
    for (const prop in query) {
      parameters[prop] = query[prop];
    }
    if (this.isOAuthSerializable(body)) {
      for (const prop in body) {
        const bodyProp = body[prop];
        if (this.isOAuthSerializable(bodyProp)) {
          parameters[prop] = typeof bodyProp === "object" && bodyProp !== null && "toString" in bodyProp ? bodyProp.toString() : bodyProp;
        }
      }
    }
    return parameters;
  }
  static moveUrlQueryParamsIntoObject(url, query) {
    for (const [param, value] of url.searchParams) {
      query[param] = value;
    }
    url.search = "";
    return url;
  }
  static applyRequestParametersToUrl(url, parameters) {
    url.pathname = url.pathname.replace(/:([A-Z_-]+)/ig, (fullMatch, paramName) => {
      if (parameters[paramName] !== undefined) {
        return String(parameters[paramName]);
      }
      return fullMatch;
    });
    return url;
  }
}
RequestParamHelpers.JSON_1_1_ENDPOINTS = new Set([
  "direct_messages/events/new.json",
  "direct_messages/welcome_messages/new.json",
  "direct_messages/welcome_messages/rules/new.json",
  "media/metadata/create.json",
  "collections/entries/curate.json"
]);
var request_param_helper_default = RequestParamHelpers;

// node_modules/twitter-api-v2/dist/esm/client-mixins/oauth2.helper.js
import * as crypto2 from "crypto";

class OAuth2Helper {
  static getCodeVerifier() {
    return this.generateRandomString(128);
  }
  static getCodeChallengeFromVerifier(verifier) {
    return this.escapeBase64Url(crypto2.createHash("sha256").update(verifier).digest("base64"));
  }
  static getAuthHeader(clientId, clientSecret) {
    const key = encodeURIComponent(clientId) + ":" + encodeURIComponent(clientSecret);
    return Buffer.from(key).toString("base64");
  }
  static generateRandomString(length) {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    for (let i = 0;i < length; i++) {
      text += possible[Math.floor(Math.random() * possible.length)];
    }
    return text;
  }
  static escapeBase64Url(string) {
    return string.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
}

// node_modules/twitter-api-v2/dist/esm/client-mixins/request-maker.mixin.js
class ClientRequestMaker {
  constructor(settings) {
    this.rateLimits = {};
    this.clientSettings = {};
    if (settings) {
      this.clientSettings = settings;
    }
  }
  getRateLimits() {
    return this.rateLimits;
  }
  saveRateLimit(originalUrl, rateLimit) {
    this.rateLimits[originalUrl] = rateLimit;
  }
  async send(requestParams) {
    var _a, _b, _c, _d, _e;
    if ((_a = this.clientSettings.plugins) === null || _a === undefined ? undefined : _a.length) {
      const possibleResponse = await this.applyPreRequestConfigHooks(requestParams);
      if (possibleResponse) {
        return possibleResponse;
      }
    }
    const args = this.getHttpRequestArgs(requestParams);
    const options = {
      method: args.method,
      headers: args.headers,
      timeout: requestParams.timeout,
      agent: this.clientSettings.httpAgent
    };
    const enableRateLimitSave = requestParams.enableRateLimitSave !== false;
    if (args.body) {
      request_param_helper_default.setBodyLengthHeader(options, args.body);
    }
    if ((_b = this.clientSettings.plugins) === null || _b === undefined ? undefined : _b.length) {
      await this.applyPreRequestHooks(requestParams, args, options);
    }
    let request2 = new request_handler_helper_default({
      url: args.url,
      options,
      body: args.body,
      rateLimitSaver: enableRateLimitSave ? this.saveRateLimit.bind(this, args.rawUrl) : undefined,
      requestEventDebugHandler: requestParams.requestEventDebugHandler,
      compression: (_d = (_c = requestParams.compression) !== null && _c !== undefined ? _c : this.clientSettings.compression) !== null && _d !== undefined ? _d : true,
      forceParseMode: requestParams.forceParseMode
    }).makeRequest();
    if (hasRequestErrorPlugins(this)) {
      request2 = this.applyResponseErrorHooks(requestParams, args, options, request2);
    }
    const response = await request2;
    if ((_e = this.clientSettings.plugins) === null || _e === undefined ? undefined : _e.length) {
      const responseOverride = await this.applyPostRequestHooks(requestParams, args, options, response);
      if (responseOverride) {
        return responseOverride.value;
      }
    }
    return response;
  }
  sendStream(requestParams) {
    var _a, _b;
    if (this.clientSettings.plugins) {
      this.applyPreStreamRequestConfigHooks(requestParams);
    }
    const args = this.getHttpRequestArgs(requestParams);
    const options = {
      method: args.method,
      headers: args.headers,
      agent: this.clientSettings.httpAgent
    };
    const enableRateLimitSave = requestParams.enableRateLimitSave !== false;
    const enableAutoConnect = requestParams.autoConnect !== false;
    if (args.body) {
      request_param_helper_default.setBodyLengthHeader(options, args.body);
    }
    const requestData = {
      url: args.url,
      options,
      body: args.body,
      rateLimitSaver: enableRateLimitSave ? this.saveRateLimit.bind(this, args.rawUrl) : undefined,
      payloadIsError: requestParams.payloadIsError,
      compression: (_b = (_a = requestParams.compression) !== null && _a !== undefined ? _a : this.clientSettings.compression) !== null && _b !== undefined ? _b : true
    };
    const stream = new TweetStream_default(requestData);
    if (!enableAutoConnect) {
      return stream;
    }
    return stream.connect();
  }
  initializeToken(token) {
    if (typeof token === "string") {
      this.bearerToken = token;
    } else if (typeof token === "object" && "appKey" in token) {
      this.consumerToken = token.appKey;
      this.consumerSecret = token.appSecret;
      if (token.accessToken && token.accessSecret) {
        this.accessToken = token.accessToken;
        this.accessSecret = token.accessSecret;
      }
      this._oauth = this.buildOAuth();
    } else if (typeof token === "object" && "username" in token) {
      const key = encodeURIComponent(token.username) + ":" + encodeURIComponent(token.password);
      this.basicToken = Buffer.from(key).toString("base64");
    } else if (typeof token === "object" && "clientId" in token) {
      this.clientId = token.clientId;
      this.clientSecret = token.clientSecret;
    }
  }
  getActiveTokens() {
    if (this.bearerToken) {
      return {
        type: "oauth2",
        bearerToken: this.bearerToken
      };
    } else if (this.basicToken) {
      return {
        type: "basic",
        token: this.basicToken
      };
    } else if (this.consumerSecret && this._oauth) {
      return {
        type: "oauth-1.0a",
        appKey: this.consumerToken,
        appSecret: this.consumerSecret,
        accessToken: this.accessToken,
        accessSecret: this.accessSecret
      };
    } else if (this.clientId) {
      return {
        type: "oauth2-user",
        clientId: this.clientId
      };
    }
    return { type: "none" };
  }
  buildOAuth() {
    if (!this.consumerSecret || !this.consumerToken)
      throw new Error("Invalid consumer tokens");
    return new oauth1_helper_default({
      consumerKeys: { key: this.consumerToken, secret: this.consumerSecret }
    });
  }
  getOAuthAccessTokens() {
    if (!this.accessSecret || !this.accessToken)
      return;
    return {
      key: this.accessToken,
      secret: this.accessSecret
    };
  }
  getPlugins() {
    var _a;
    return (_a = this.clientSettings.plugins) !== null && _a !== undefined ? _a : [];
  }
  hasPlugins() {
    var _a;
    return !!((_a = this.clientSettings.plugins) === null || _a === undefined ? undefined : _a.length);
  }
  async applyPluginMethod(method, args) {
    var _a;
    let returnValue;
    for (const plugin of this.getPlugins()) {
      const value = await ((_a = plugin[method]) === null || _a === undefined ? undefined : _a.call(plugin, args));
      if (value && value instanceof TwitterApiPluginResponseOverride) {
        returnValue = value;
      }
    }
    return returnValue;
  }
  writeAuthHeaders({ headers, bodyInSignature, url, method, query, body }) {
    headers = { ...headers };
    if (this.bearerToken) {
      headers.Authorization = "Bearer " + this.bearerToken;
    } else if (this.basicToken) {
      headers.Authorization = "Basic " + this.basicToken;
    } else if (this.clientId && this.clientSecret) {
      headers.Authorization = "Basic " + OAuth2Helper.getAuthHeader(this.clientId, this.clientSecret);
    } else if (this.consumerSecret && this._oauth) {
      const data = bodyInSignature ? request_param_helper_default.mergeQueryAndBodyForOAuth(query, body) : query;
      const auth2 = this._oauth.authorize({
        url: url.toString(),
        method,
        data
      }, this.getOAuthAccessTokens());
      headers = { ...headers, ...this._oauth.toHeader(auth2) };
    }
    return headers;
  }
  getUrlObjectFromUrlString(url) {
    if (!url.startsWith("http")) {
      url = "https://" + url;
    }
    return new URL(url);
  }
  getHttpRequestArgs({ url: stringUrl, method, query: rawQuery = {}, body: rawBody = {}, headers, forceBodyMode, enableAuth, params }) {
    let body = undefined;
    method = method.toUpperCase();
    headers = headers !== null && headers !== undefined ? headers : {};
    if (!headers["x-user-agent"]) {
      headers["x-user-agent"] = "Node.twitter-api-v2";
    }
    const url = this.getUrlObjectFromUrlString(stringUrl);
    const rawUrl = url.origin + url.pathname;
    if (params) {
      request_param_helper_default.applyRequestParametersToUrl(url, params);
    }
    const query = request_param_helper_default.formatQueryToString(rawQuery);
    request_param_helper_default.moveUrlQueryParamsIntoObject(url, query);
    if (!(rawBody instanceof Buffer)) {
      trimUndefinedProperties(rawBody);
    }
    const bodyType = forceBodyMode !== null && forceBodyMode !== undefined ? forceBodyMode : request_param_helper_default.autoDetectBodyType(url);
    if (enableAuth !== false) {
      const bodyInSignature = ClientRequestMaker.BODY_METHODS.has(method) && bodyType === "url";
      headers = this.writeAuthHeaders({ headers, bodyInSignature, method, query, url, body: rawBody });
    }
    if (ClientRequestMaker.BODY_METHODS.has(method)) {
      body = request_param_helper_default.constructBodyParams(rawBody, headers, bodyType) || undefined;
    }
    request_param_helper_default.addQueryParamsToUrl(url, query);
    return {
      rawUrl,
      url,
      method,
      headers,
      body
    };
  }
  async applyPreRequestConfigHooks(requestParams) {
    var _a;
    const url = this.getUrlObjectFromUrlString(requestParams.url);
    for (const plugin of this.getPlugins()) {
      const result = await ((_a = plugin.onBeforeRequestConfig) === null || _a === undefined ? undefined : _a.call(plugin, {
        client: this,
        url,
        params: requestParams
      }));
      if (result) {
        return result;
      }
    }
  }
  applyPreStreamRequestConfigHooks(requestParams) {
    var _a;
    const url = this.getUrlObjectFromUrlString(requestParams.url);
    for (const plugin of this.getPlugins()) {
      (_a = plugin.onBeforeStreamRequestConfig) === null || _a === undefined || _a.call(plugin, {
        client: this,
        url,
        params: requestParams
      });
    }
  }
  async applyPreRequestHooks(requestParams, computedParams, requestOptions) {
    await this.applyPluginMethod("onBeforeRequest", {
      client: this,
      url: this.getUrlObjectFromUrlString(requestParams.url),
      params: requestParams,
      computedParams,
      requestOptions
    });
  }
  async applyPostRequestHooks(requestParams, computedParams, requestOptions, response) {
    return await this.applyPluginMethod("onAfterRequest", {
      client: this,
      url: this.getUrlObjectFromUrlString(requestParams.url),
      params: requestParams,
      computedParams,
      requestOptions,
      response
    });
  }
  applyResponseErrorHooks(requestParams, computedParams, requestOptions, promise) {
    return promise.catch(applyResponseHooks.bind(this, requestParams, computedParams, requestOptions));
  }
}
ClientRequestMaker.BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// node_modules/twitter-api-v2/dist/esm/client.base.js
class TwitterApiBase {
  constructor(token, settings = {}) {
    this._currentUser = null;
    this._currentUserV2 = null;
    if (token instanceof TwitterApiBase) {
      this._requestMaker = token._requestMaker;
    } else {
      this._requestMaker = new ClientRequestMaker(settings);
      this._requestMaker.initializeToken(token);
    }
  }
  setPrefix(prefix) {
    this._prefix = prefix;
  }
  cloneWithPrefix(prefix) {
    const clone = this.constructor(this);
    clone.setPrefix(prefix);
    return clone;
  }
  getActiveTokens() {
    return this._requestMaker.getActiveTokens();
  }
  getPlugins() {
    return this._requestMaker.getPlugins();
  }
  getPluginOfType(type) {
    return this.getPlugins().find((plugin) => plugin instanceof type);
  }
  hasHitRateLimit(endpoint) {
    var _a;
    if (this.isRateLimitStatusObsolete(endpoint)) {
      return false;
    }
    return ((_a = this.getLastRateLimitStatus(endpoint)) === null || _a === undefined ? undefined : _a.remaining) === 0;
  }
  isRateLimitStatusObsolete(endpoint) {
    const rateLimit = this.getLastRateLimitStatus(endpoint);
    if (rateLimit === undefined) {
      return true;
    }
    return rateLimit.reset * 1000 < Date.now();
  }
  getLastRateLimitStatus(endpoint) {
    const endpointWithPrefix = endpoint.match(/^https?:\/\//) ? endpoint : this._prefix + endpoint;
    return this._requestMaker.getRateLimits()[endpointWithPrefix];
  }
  getCurrentUserObject(forceFetch = false) {
    if (!forceFetch && this._currentUser) {
      if (this._currentUser.value) {
        return Promise.resolve(this._currentUser.value);
      }
      return this._currentUser.promise;
    }
    this._currentUser = sharedPromise(() => this.get("account/verify_credentials.json", { tweet_mode: "extended" }, { prefix: API_V1_1_PREFIX }));
    return this._currentUser.promise;
  }
  getCurrentUserV2Object(forceFetch = false) {
    if (!forceFetch && this._currentUserV2) {
      if (this._currentUserV2.value) {
        return Promise.resolve(this._currentUserV2.value);
      }
      return this._currentUserV2.promise;
    }
    this._currentUserV2 = sharedPromise(() => this.get("users/me", undefined, { prefix: API_V2_PREFIX }));
    return this._currentUserV2.promise;
  }
  async get(url, query = {}, { fullResponse, prefix = this._prefix, ...rest } = {}) {
    if (prefix)
      url = prefix + url;
    const resp = await this._requestMaker.send({
      url,
      method: "GET",
      query,
      ...rest
    });
    return fullResponse ? resp : resp.data;
  }
  async delete(url, query = {}, { fullResponse, prefix = this._prefix, ...rest } = {}) {
    if (prefix)
      url = prefix + url;
    const resp = await this._requestMaker.send({
      url,
      method: "DELETE",
      query,
      ...rest
    });
    return fullResponse ? resp : resp.data;
  }
  async post(url, body, { fullResponse, prefix = this._prefix, ...rest } = {}) {
    if (prefix)
      url = prefix + url;
    const resp = await this._requestMaker.send({
      url,
      method: "POST",
      body,
      ...rest
    });
    return fullResponse ? resp : resp.data;
  }
  async put(url, body, { fullResponse, prefix = this._prefix, ...rest } = {}) {
    if (prefix)
      url = prefix + url;
    const resp = await this._requestMaker.send({
      url,
      method: "PUT",
      body,
      ...rest
    });
    return fullResponse ? resp : resp.data;
  }
  async patch(url, body, { fullResponse, prefix = this._prefix, ...rest } = {}) {
    if (prefix)
      url = prefix + url;
    const resp = await this._requestMaker.send({
      url,
      method: "PATCH",
      body,
      ...rest
    });
    return fullResponse ? resp : resp.data;
  }
  getStream(url, query, { prefix = this._prefix, ...rest } = {}) {
    return this._requestMaker.sendStream({
      url: prefix ? prefix + url : url,
      method: "GET",
      query,
      ...rest
    });
  }
  postStream(url, body, { prefix = this._prefix, ...rest } = {}) {
    return this._requestMaker.sendStream({
      url: prefix ? prefix + url : url,
      method: "POST",
      body,
      ...rest
    });
  }
}

// node_modules/twitter-api-v2/dist/esm/client.subclient.js
class TwitterApiSubClient extends TwitterApiBase {
  constructor(instance) {
    if (!(instance instanceof TwitterApiBase)) {
      throw new Error("You must instance SubTwitterApi instance from existing TwitterApi instance.");
    }
    super(instance);
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/tweet.paginator.v1.js
class TweetTimelineV1Paginator extends TwitterPaginator_default {
  constructor() {
    super(...arguments);
    this.hasFinishedFetch = false;
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.push(...result);
      this.hasFinishedFetch = result.length === 0;
    }
  }
  getNextQueryParams(maxResults) {
    const latestId = BigInt(this._realData[this._realData.length - 1].id_str);
    return {
      ...this.injectQueryParams(maxResults),
      max_id: (latestId - BigInt(1)).toString()
    };
  }
  getPageLengthFromRequest(result) {
    return result.data.length;
  }
  isFetchLastOver(result) {
    return !result.data.length;
  }
  canFetchNextPage(result) {
    return result.length > 0;
  }
  getItemArray() {
    return this.tweets;
  }
  get tweets() {
    return this._realData;
  }
  get done() {
    return super.done || this.hasFinishedFetch;
  }
}

class HomeTimelineV1Paginator extends TweetTimelineV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "statuses/home_timeline.json";
  }
}

class MentionTimelineV1Paginator extends TweetTimelineV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "statuses/mentions_timeline.json";
  }
}

class UserTimelineV1Paginator extends TweetTimelineV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "statuses/user_timeline.json";
  }
}

class ListTimelineV1Paginator extends TweetTimelineV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/statuses.json";
  }
}

class UserFavoritesV1Paginator extends TweetTimelineV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "favorites/list.json";
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/mutes.paginator.v1.js
class MuteUserListV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "mutes/users/list.json";
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.users.push(...result.users);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.users.length;
  }
  getItemArray() {
    return this.users;
  }
  get users() {
    return this._realData.users;
  }
}

class MuteUserIdsV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "mutes/users/ids.json";
    this._maxResultsWhenFetchLast = 5000;
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.ids.push(...result.ids);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.ids.length;
  }
  getItemArray() {
    return this.ids;
  }
  get ids() {
    return this._realData.ids;
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/followers.paginator.v1.js
class UserFollowerListV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "followers/list.json";
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.users.push(...result.users);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.users.length;
  }
  getItemArray() {
    return this.users;
  }
  get users() {
    return this._realData.users;
  }
}

class UserFollowerIdsV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "followers/ids.json";
    this._maxResultsWhenFetchLast = 5000;
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.ids.push(...result.ids);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.ids.length;
  }
  getItemArray() {
    return this.ids;
  }
  get ids() {
    return this._realData.ids;
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/friends.paginator.v1.js
class UserFriendListV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "friends/list.json";
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.users.push(...result.users);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.users.length;
  }
  getItemArray() {
    return this.users;
  }
  get users() {
    return this._realData.users;
  }
}

class UserFollowersIdsV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "friends/ids.json";
    this._maxResultsWhenFetchLast = 5000;
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.ids.push(...result.ids);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.ids.length;
  }
  getItemArray() {
    return this.ids;
  }
  get ids() {
    return this._realData.ids;
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/user.paginator.v1.js
class UserSearchV1Paginator extends TwitterPaginator_default {
  constructor() {
    super(...arguments);
    this._endpoint = "users/search.json";
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.push(...result);
    }
  }
  getNextQueryParams(maxResults) {
    var _a;
    const previousPage = Number((_a = this._queryParams.page) !== null && _a !== undefined ? _a : "1");
    return {
      ...this._queryParams,
      page: previousPage + 1,
      ...maxResults ? { count: maxResults } : {}
    };
  }
  getPageLengthFromRequest(result) {
    return result.data.length;
  }
  isFetchLastOver(result) {
    return !result.data.length;
  }
  canFetchNextPage(result) {
    return result.length > 0;
  }
  getItemArray() {
    return this.users;
  }
  get users() {
    return this._realData;
  }
}

class FriendshipsIncomingV1Paginator extends CursoredV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "friendships/incoming.json";
    this._maxResultsWhenFetchLast = 5000;
  }
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.ids.push(...result.ids);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.ids.length;
  }
  getItemArray() {
    return this.ids;
  }
  get ids() {
    return this._realData.ids;
  }
}

class FriendshipsOutgoingV1Paginator extends FriendshipsIncomingV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "friendships/outgoing.json";
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/list.paginator.v1.js
class ListListsV1Paginator extends CursoredV1Paginator {
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.lists.push(...result.lists);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.lists.length;
  }
  getItemArray() {
    return this.lists;
  }
  get lists() {
    return this._realData.lists;
  }
}

class ListMembershipsV1Paginator extends ListListsV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/memberships.json";
  }
}

class ListOwnershipsV1Paginator extends ListListsV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/ownerships.json";
  }
}

class ListSubscriptionsV1Paginator extends ListListsV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/subscriptions.json";
  }
}

class ListUsersV1Paginator extends CursoredV1Paginator {
  refreshInstanceFromResult(response, isNextPage) {
    const result = response.data;
    this._rateLimit = response.rateLimit;
    if (isNextPage) {
      this._realData.users.push(...result.users);
      this._realData.next_cursor = result.next_cursor;
    }
  }
  getPageLengthFromRequest(result) {
    return result.data.users.length;
  }
  getItemArray() {
    return this.users;
  }
  get users() {
    return this._realData.users;
  }
}

class ListMembersV1Paginator extends ListUsersV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/members.json";
  }
}

class ListSubscribersV1Paginator extends ListUsersV1Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/subscribers.json";
  }
}

// node_modules/twitter-api-v2/dist/esm/v1/client.v1.read.js
class TwitterApiv1ReadOnly extends TwitterApiSubClient {
  constructor() {
    super(...arguments);
    this._prefix = API_V1_1_PREFIX;
  }
  singleTweet(tweetId, options = {}) {
    return this.get("statuses/show.json", { tweet_mode: "extended", id: tweetId, ...options });
  }
  tweets(ids, options = {}) {
    return this.post("statuses/lookup.json", { tweet_mode: "extended", id: ids, ...options });
  }
  oembedTweet(tweetId, options = {}) {
    return this.get("oembed", {
      url: `https://x.com/i/statuses/${tweetId}`,
      ...options
    }, { prefix: "https://publish.x.com/" });
  }
  async homeTimeline(options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("statuses/home_timeline.json", queryParams, { fullResponse: true });
    return new HomeTimelineV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async mentionTimeline(options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("statuses/mentions_timeline.json", queryParams, { fullResponse: true });
    return new MentionTimelineV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async userTimeline(userId, options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      user_id: userId,
      ...options
    };
    const initialRq = await this.get("statuses/user_timeline.json", queryParams, { fullResponse: true });
    return new UserTimelineV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async userTimelineByUsername(username, options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      screen_name: username,
      ...options
    };
    const initialRq = await this.get("statuses/user_timeline.json", queryParams, { fullResponse: true });
    return new UserTimelineV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async favoriteTimeline(userId, options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      user_id: userId,
      ...options
    };
    const initialRq = await this.get("favorites/list.json", queryParams, { fullResponse: true });
    return new UserFavoritesV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async favoriteTimelineByUsername(username, options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      screen_name: username,
      ...options
    };
    const initialRq = await this.get("favorites/list.json", queryParams, { fullResponse: true });
    return new UserFavoritesV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  user(user) {
    return this.get("users/show.json", { tweet_mode: "extended", ...user });
  }
  users(query) {
    return this.get("users/lookup.json", { tweet_mode: "extended", ...query });
  }
  verifyCredentials(options = {}) {
    return this.get("account/verify_credentials.json", options);
  }
  async listMutedUsers(options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("mutes/users/list.json", queryParams, { fullResponse: true });
    return new MuteUserListV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async listMutedUserIds(options = {}) {
    const queryParams = {
      stringify_ids: true,
      ...options
    };
    const initialRq = await this.get("mutes/users/ids.json", queryParams, { fullResponse: true });
    return new MuteUserIdsV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async userFriendList(options = {}) {
    const queryParams = {
      ...options
    };
    const initialRq = await this.get("friends/list.json", queryParams, { fullResponse: true });
    return new UserFriendListV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async userFollowerList(options = {}) {
    const queryParams = {
      ...options
    };
    const initialRq = await this.get("followers/list.json", queryParams, { fullResponse: true });
    return new UserFollowerListV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async userFollowerIds(options = {}) {
    const queryParams = {
      stringify_ids: true,
      ...options
    };
    const initialRq = await this.get("followers/ids.json", queryParams, { fullResponse: true });
    return new UserFollowerIdsV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async userFollowingIds(options = {}) {
    const queryParams = {
      stringify_ids: true,
      ...options
    };
    const initialRq = await this.get("friends/ids.json", queryParams, { fullResponse: true });
    return new UserFollowersIdsV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async searchUsers(query, options = {}) {
    const queryParams = {
      q: query,
      tweet_mode: "extended",
      page: 1,
      ...options
    };
    const initialRq = await this.get("users/search.json", queryParams, { fullResponse: true });
    return new UserSearchV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  friendship(sources) {
    return this.get("friendships/show.json", sources);
  }
  friendships(friendships) {
    return this.get("friendships/lookup.json", friendships);
  }
  friendshipsNoRetweets() {
    return this.get("friendships/no_retweets/ids.json", { stringify_ids: true });
  }
  async friendshipsIncoming(options = {}) {
    const queryParams = {
      stringify_ids: true,
      ...options
    };
    const initialRq = await this.get("friendships/incoming.json", queryParams, { fullResponse: true });
    return new FriendshipsIncomingV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async friendshipsOutgoing(options = {}) {
    const queryParams = {
      stringify_ids: true,
      ...options
    };
    const initialRq = await this.get("friendships/outgoing.json", queryParams, { fullResponse: true });
    return new FriendshipsOutgoingV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  accountSettings() {
    return this.get("account/settings.json");
  }
  userProfileBannerSizes(params) {
    return this.get("users/profile_banner.json", params);
  }
  list(options) {
    return this.get("lists/show.json", { tweet_mode: "extended", ...options });
  }
  lists(options = {}) {
    return this.get("lists/list.json", { tweet_mode: "extended", ...options });
  }
  async listMembers(options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("lists/members.json", queryParams, { fullResponse: true });
    return new ListMembersV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  listGetMember(options) {
    return this.get("lists/members/show.json", { tweet_mode: "extended", ...options });
  }
  async listMemberships(options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("lists/memberships.json", queryParams, { fullResponse: true });
    return new ListMembershipsV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async listOwnerships(options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("lists/ownerships.json", queryParams, { fullResponse: true });
    return new ListOwnershipsV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async listStatuses(options) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("lists/statuses.json", queryParams, { fullResponse: true });
    return new ListTimelineV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async listSubscribers(options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("lists/subscribers.json", queryParams, { fullResponse: true });
    return new ListSubscribersV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  listGetSubscriber(options) {
    return this.get("lists/subscribers/show.json", { tweet_mode: "extended", ...options });
  }
  async listSubscriptions(options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      ...options
    };
    const initialRq = await this.get("lists/subscriptions.json", queryParams, { fullResponse: true });
    return new ListSubscriptionsV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  mediaInfo(mediaId) {
    return this.get("media/upload.json", {
      command: "STATUS",
      media_id: mediaId
    }, { prefix: API_V1_1_UPLOAD_PREFIX });
  }
  filterStream({ autoConnect, ...params } = {}) {
    const parameters = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === "follow" || key === "track") {
        parameters[key] = value.toString();
      } else if (key === "locations") {
        const locations = value;
        parameters.locations = arrayWrap(locations).map((loc) => `${loc.lng},${loc.lat}`).join(",");
      } else {
        parameters[key] = value;
      }
    }
    const streamClient = this.stream;
    return streamClient.postStream("statuses/filter.json", parameters, { autoConnect });
  }
  sampleStream({ autoConnect, ...params } = {}) {
    const streamClient = this.stream;
    return streamClient.getStream("statuses/sample.json", params, { autoConnect });
  }
  get stream() {
    const copiedClient = new client_v1_default(this);
    copiedClient.setPrefix(API_V1_1_STREAM_PREFIX);
    return copiedClient;
  }
  trendsByPlace(woeId, options = {}) {
    return this.get("trends/place.json", { id: woeId, ...options });
  }
  trendsAvailable() {
    return this.get("trends/available.json");
  }
  trendsClosest(lat, long) {
    return this.get("trends/closest.json", { lat, long });
  }
  geoPlace(placeId) {
    return this.get("geo/id/:place_id.json", undefined, { params: { place_id: placeId } });
  }
  geoSearch(options) {
    return this.get("geo/search.json", options);
  }
  geoReverseGeoCode(options) {
    return this.get("geo/reverse_geocode.json", options);
  }
  rateLimitStatuses(...resources) {
    return this.get("application/rate_limit_status.json", { resources });
  }
  supportedLanguages() {
    return this.get("help/languages.json");
  }
}

// node_modules/twitter-api-v2/dist/esm/v1/media-helpers.v1.js
import * as fs from "fs";
async function readFileIntoBuffer(file) {
  const handle = await getFileHandle(file);
  if (typeof handle === "number") {
    return new Promise((resolve, reject) => {
      fs.readFile(handle, (err, data) => {
        if (err) {
          return reject(err);
        }
        resolve(data);
      });
    });
  } else if (handle instanceof Buffer) {
    return handle;
  } else {
    return handle.readFile();
  }
}
function getFileHandle(file) {
  if (typeof file === "string") {
    return fs.promises.open(file, "r");
  } else if (typeof file === "number") {
    return file;
  } else if (typeof file === "object" && !(file instanceof Buffer)) {
    return file;
  } else if (!(file instanceof Buffer)) {
    throw new Error("Given file is not valid, please check its type.");
  } else {
    return file;
  }
}
async function getFileSizeFromFileHandle(fileHandle) {
  if (typeof fileHandle === "number") {
    const stats = await new Promise((resolve, reject) => {
      fs.fstat(fileHandle, (err, stats2) => {
        if (err)
          reject(err);
        resolve(stats2);
      });
    });
    return stats.size;
  } else if (fileHandle instanceof Buffer) {
    return fileHandle.length;
  } else {
    return (await fileHandle.stat()).size;
  }
}
function getMimeType(file, type, mimeType) {
  if (typeof mimeType === "string") {
    return mimeType;
  } else if (typeof file === "string" && !type) {
    return getMimeByName(file);
  } else if (typeof type === "string") {
    return getMimeByType(type);
  }
  throw new Error("You must specify type if file is a file handle or Buffer.");
}
function getMimeByName(name) {
  if (name.endsWith(".jpeg") || name.endsWith(".jpg"))
    return EUploadMimeType.Jpeg;
  if (name.endsWith(".png"))
    return EUploadMimeType.Png;
  if (name.endsWith(".webp"))
    return EUploadMimeType.Webp;
  if (name.endsWith(".gif"))
    return EUploadMimeType.Gif;
  if (name.endsWith(".mpeg4") || name.endsWith(".mp4"))
    return EUploadMimeType.Mp4;
  if (name.endsWith(".mov") || name.endsWith(".mov"))
    return EUploadMimeType.Mov;
  if (name.endsWith(".srt"))
    return EUploadMimeType.Srt;
  safeDeprecationWarning({
    instance: "TwitterApiv1ReadWrite",
    method: "uploadMedia",
    problem: "options.mimeType is missing and filename couldn't help to resolve MIME type, so it will fallback to image/jpeg",
    resolution: "If you except to give filenames without extensions, please specify explicitlty the MIME type using options.mimeType"
  });
  return EUploadMimeType.Jpeg;
}
function getMimeByType(type) {
  safeDeprecationWarning({
    instance: "TwitterApiv1ReadWrite",
    method: "uploadMedia",
    problem: "you're using options.type",
    resolution: "Remove options.type argument and migrate to options.mimeType which takes the real MIME type. " + "If you're using type=longmp4, add options.longVideo alongside of mimeType=EUploadMimeType.Mp4"
  });
  if (type === "gif")
    return EUploadMimeType.Gif;
  if (type === "jpg")
    return EUploadMimeType.Jpeg;
  if (type === "png")
    return EUploadMimeType.Png;
  if (type === "webp")
    return EUploadMimeType.Webp;
  if (type === "srt")
    return EUploadMimeType.Srt;
  if (type === "mp4" || type === "longmp4")
    return EUploadMimeType.Mp4;
  if (type === "mov")
    return EUploadMimeType.Mov;
  return type;
}
function getMediaCategoryByMime(name, target) {
  if (name === EUploadMimeType.Mp4 || name === EUploadMimeType.Mov)
    return target === "tweet" ? "TweetVideo" : "DmVideo";
  if (name === EUploadMimeType.Gif)
    return target === "tweet" ? "TweetGif" : "DmGif";
  if (name === EUploadMimeType.Srt)
    return "Subtitles";
  else
    return target === "tweet" ? "TweetImage" : "DmImage";
}
function sleepSecs(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
async function readNextPartOf(file, chunkLength, bufferOffset = 0, buffer) {
  if (file instanceof Buffer) {
    const rt = file.slice(bufferOffset, bufferOffset + chunkLength);
    return [rt, rt.length];
  }
  if (!buffer) {
    throw new Error("Well, we will need a buffer to store file content.");
  }
  let bytesRead;
  if (typeof file === "number") {
    bytesRead = await new Promise((resolve, reject) => {
      fs.read(file, buffer, 0, chunkLength, bufferOffset, (err, nread) => {
        if (err)
          reject(err);
        resolve(nread);
      });
    });
  } else {
    const res = await file.read(buffer, 0, chunkLength, bufferOffset);
    bytesRead = res.bytesRead;
  }
  return [buffer, bytesRead];
}

// node_modules/twitter-api-v2/dist/esm/v1/client.v1.write.js
var UPLOAD_ENDPOINT = "media/upload.json";

class TwitterApiv1ReadWrite extends TwitterApiv1ReadOnly {
  constructor() {
    super(...arguments);
    this._prefix = API_V1_1_PREFIX;
  }
  get readOnly() {
    return this;
  }
  tweet(status, payload = {}) {
    const queryParams = {
      status,
      tweet_mode: "extended",
      ...payload
    };
    return this.post("statuses/update.json", queryParams);
  }
  async quote(status, quotingStatusId, payload = {}) {
    const url = "https://x.com/i/statuses/" + quotingStatusId;
    return this.tweet(status, { ...payload, attachment_url: url });
  }
  async tweetThread(tweets) {
    const postedTweets = [];
    for (const tweet of tweets) {
      const lastTweet = postedTweets.length ? postedTweets[postedTweets.length - 1] : null;
      const queryParams = { ...typeof tweet === "string" ? { status: tweet } : tweet };
      const inReplyToId = lastTweet ? lastTweet.id_str : queryParams.in_reply_to_status_id;
      const status = queryParams.status;
      if (inReplyToId) {
        postedTweets.push(await this.reply(status, inReplyToId, queryParams));
      } else {
        postedTweets.push(await this.tweet(status, queryParams));
      }
    }
    return postedTweets;
  }
  reply(status, in_reply_to_status_id, payload = {}) {
    return this.tweet(status, {
      auto_populate_reply_metadata: true,
      in_reply_to_status_id,
      ...payload
    });
  }
  deleteTweet(tweetId) {
    return this.post("statuses/destroy/:id.json", { tweet_mode: "extended" }, { params: { id: tweetId } });
  }
  reportUserAsSpam(options) {
    return this.post("users/report_spam.json", { tweet_mode: "extended", ...options });
  }
  updateFriendship(options) {
    return this.post("friendships/update.json", options);
  }
  createFriendship(options) {
    return this.post("friendships/create.json", options);
  }
  destroyFriendship(options) {
    return this.post("friendships/destroy.json", options);
  }
  updateAccountSettings(options) {
    return this.post("account/settings.json", options);
  }
  updateAccountProfile(options) {
    return this.post("account/update_profile.json", options);
  }
  async updateAccountProfileBanner(file, options = {}) {
    const queryParams = {
      banner: await readFileIntoBuffer(file),
      ...options
    };
    return this.post("account/update_profile_banner.json", queryParams, { forceBodyMode: "form-data" });
  }
  async updateAccountProfileImage(file, options = {}) {
    const queryParams = {
      tweet_mode: "extended",
      image: await readFileIntoBuffer(file),
      ...options
    };
    return this.post("account/update_profile_image.json", queryParams, { forceBodyMode: "form-data" });
  }
  removeAccountProfileBanner() {
    return this.post("account/remove_profile_banner.json");
  }
  createList(options) {
    return this.post("lists/create.json", { tweet_mode: "extended", ...options });
  }
  updateList(options) {
    return this.post("lists/update.json", { tweet_mode: "extended", ...options });
  }
  removeList(options) {
    return this.post("lists/destroy.json", { tweet_mode: "extended", ...options });
  }
  addListMembers(options) {
    const hasMultiple = options.user_id && hasMultipleItems(options.user_id) || options.screen_name && hasMultipleItems(options.screen_name);
    const endpoint = hasMultiple ? "lists/members/create_all.json" : "lists/members/create.json";
    return this.post(endpoint, options);
  }
  removeListMembers(options) {
    const hasMultiple = options.user_id && hasMultipleItems(options.user_id) || options.screen_name && hasMultipleItems(options.screen_name);
    const endpoint = hasMultiple ? "lists/members/destroy_all.json" : "lists/members/destroy.json";
    return this.post(endpoint, options);
  }
  subscribeToList(options) {
    return this.post("lists/subscribers/create.json", { tweet_mode: "extended", ...options });
  }
  unsubscribeOfList(options) {
    return this.post("lists/subscribers/destroy.json", { tweet_mode: "extended", ...options });
  }
  createMediaMetadata(mediaId, metadata) {
    return this.post("media/metadata/create.json", { media_id: mediaId, ...metadata }, { prefix: API_V1_1_UPLOAD_PREFIX, forceBodyMode: "json" });
  }
  createMediaSubtitles(mediaId, subtitles) {
    return this.post("media/subtitles/create.json", { media_id: mediaId, media_category: "TweetVideo", subtitle_info: { subtitles } }, { prefix: API_V1_1_UPLOAD_PREFIX, forceBodyMode: "json" });
  }
  deleteMediaSubtitles(mediaId, ...languages) {
    return this.post("media/subtitles/delete.json", {
      media_id: mediaId,
      media_category: "TweetVideo",
      subtitle_info: { subtitles: languages.map((lang) => ({ language_code: lang })) }
    }, { prefix: API_V1_1_UPLOAD_PREFIX, forceBodyMode: "json" });
  }
  async uploadMedia(file, options = {}, returnFullMediaData = false) {
    var _a;
    const chunkLength = (_a = options.chunkLength) !== null && _a !== undefined ? _a : 1024 * 1024;
    const { fileHandle, mediaCategory, fileSize, mimeType } = await this.getUploadMediaRequirements(file, options);
    try {
      const mediaData = await this.post(UPLOAD_ENDPOINT, {
        command: "INIT",
        total_bytes: fileSize,
        media_type: mimeType,
        media_category: mediaCategory,
        additional_owners: options.additionalOwners,
        shared: options.shared ? true : undefined
      }, { prefix: API_V1_1_UPLOAD_PREFIX });
      await this.mediaChunkedUpload(fileHandle, chunkLength, mediaData.media_id_string, options.maxConcurrentUploads);
      const fullMediaData = await this.post(UPLOAD_ENDPOINT, {
        command: "FINALIZE",
        media_id: mediaData.media_id_string
      }, { prefix: API_V1_1_UPLOAD_PREFIX });
      if (fullMediaData.processing_info && fullMediaData.processing_info.state !== "succeeded") {
        await this.awaitForMediaProcessingCompletion(fullMediaData);
      }
      if (returnFullMediaData) {
        return fullMediaData;
      } else {
        return fullMediaData.media_id_string;
      }
    } finally {
      if (typeof file === "number") {
        fs2.close(file, () => {});
      } else if (typeof fileHandle === "object" && !(fileHandle instanceof Buffer)) {
        fileHandle.close();
      }
    }
  }
  async awaitForMediaProcessingCompletion(fullMediaData) {
    var _a;
    while (true) {
      fullMediaData = await this.mediaInfo(fullMediaData.media_id_string);
      const { processing_info } = fullMediaData;
      if (!processing_info || processing_info.state === "succeeded") {
        return;
      }
      if ((_a = processing_info.error) === null || _a === undefined ? undefined : _a.code) {
        const { name, message } = processing_info.error;
        throw new Error(`Failed to process media: ${name} - ${message}.`);
      }
      if (processing_info.state === "failed") {
        throw new Error("Failed to process the media.");
      }
      if (processing_info.check_after_secs) {
        await sleepSecs(processing_info.check_after_secs);
      } else {
        await sleepSecs(5);
      }
    }
  }
  async getUploadMediaRequirements(file, { mimeType, type, target, longVideo } = {}) {
    let fileHandle;
    try {
      fileHandle = await getFileHandle(file);
      const realMimeType = getMimeType(file, type, mimeType);
      let mediaCategory;
      if (realMimeType === EUploadMimeType.Mp4 && (!mimeType && !type && target !== "dm" || longVideo)) {
        mediaCategory = "amplify_video";
      } else {
        mediaCategory = getMediaCategoryByMime(realMimeType, target !== null && target !== undefined ? target : "tweet");
      }
      return {
        fileHandle,
        mediaCategory,
        fileSize: await getFileSizeFromFileHandle(fileHandle),
        mimeType: realMimeType
      };
    } catch (e) {
      if (typeof file === "number") {
        fs2.close(file, () => {});
      } else if (typeof fileHandle === "object" && !(fileHandle instanceof Buffer)) {
        fileHandle.close();
      }
      throw e;
    }
  }
  async mediaChunkedUpload(fileHandle, chunkLength, mediaId, maxConcurrentUploads = 3) {
    let chunkIndex = 0;
    if (maxConcurrentUploads < 1) {
      throw new RangeError("Bad maxConcurrentUploads parameter.");
    }
    const buffer = fileHandle instanceof Buffer ? undefined : Buffer.alloc(chunkLength);
    let readBuffer;
    let nread;
    let offset = 0;
    [readBuffer, nread] = await readNextPartOf(fileHandle, chunkLength, offset, buffer);
    offset += nread;
    const currentUploads = new Set;
    while (nread) {
      const mediaBufferPart = readBuffer.slice(0, nread);
      if (mediaBufferPart.length) {
        const request2 = this.post(UPLOAD_ENDPOINT, {
          command: "APPEND",
          media_id: mediaId,
          segment_index: chunkIndex,
          media: mediaBufferPart
        }, { prefix: API_V1_1_UPLOAD_PREFIX });
        currentUploads.add(request2);
        request2.then(() => {
          currentUploads.delete(request2);
        });
        chunkIndex++;
      }
      if (currentUploads.size >= maxConcurrentUploads) {
        await Promise.race(currentUploads);
      }
      [readBuffer, nread] = await readNextPartOf(fileHandle, chunkLength, offset, buffer);
      offset += nread;
    }
    await Promise.all([...currentUploads]);
  }
}

// node_modules/twitter-api-v2/dist/esm/v1/client.v1.js
class TwitterApiv1 extends TwitterApiv1ReadWrite {
  constructor() {
    super(...arguments);
    this._prefix = API_V1_1_PREFIX;
  }
  get readWrite() {
    return this;
  }
  sendDm({ recipient_id, custom_profile_id, ...params }) {
    const args = {
      event: {
        type: EDirectMessageEventTypeV1.Create,
        [EDirectMessageEventTypeV1.Create]: {
          target: { recipient_id },
          message_data: params
        }
      }
    };
    if (custom_profile_id) {
      args.event[EDirectMessageEventTypeV1.Create].custom_profile_id = custom_profile_id;
    }
    return this.post("direct_messages/events/new.json", args, {
      forceBodyMode: "json"
    });
  }
  getDmEvent(id) {
    return this.get("direct_messages/events/show.json", { id });
  }
  deleteDm(id) {
    return this.delete("direct_messages/events/destroy.json", { id });
  }
  async listDmEvents(args = {}) {
    const queryParams = { ...args };
    const initialRq = await this.get("direct_messages/events/list.json", queryParams, { fullResponse: true });
    return new DmEventsV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  newWelcomeDm(name, data) {
    const args = {
      [EDirectMessageEventTypeV1.WelcomeCreate]: {
        name,
        message_data: data
      }
    };
    return this.post("direct_messages/welcome_messages/new.json", args, {
      forceBodyMode: "json"
    });
  }
  getWelcomeDm(id) {
    return this.get("direct_messages/welcome_messages/show.json", { id });
  }
  deleteWelcomeDm(id) {
    return this.delete("direct_messages/welcome_messages/destroy.json", { id });
  }
  updateWelcomeDm(id, data) {
    const args = { message_data: data };
    return this.put("direct_messages/welcome_messages/update.json", args, {
      forceBodyMode: "json",
      query: { id }
    });
  }
  async listWelcomeDms(args = {}) {
    const queryParams = { ...args };
    const initialRq = await this.get("direct_messages/welcome_messages/list.json", queryParams, { fullResponse: true });
    return new WelcomeDmV1Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  newWelcomeDmRule(welcomeMessageId) {
    return this.post("direct_messages/welcome_messages/rules/new.json", {
      welcome_message_rule: { welcome_message_id: welcomeMessageId }
    }, {
      forceBodyMode: "json"
    });
  }
  getWelcomeDmRule(id) {
    return this.get("direct_messages/welcome_messages/rules/show.json", { id });
  }
  deleteWelcomeDmRule(id) {
    return this.delete("direct_messages/welcome_messages/rules/destroy.json", { id });
  }
  async listWelcomeDmRules(args = {}) {
    const queryParams = { ...args };
    return this.get("direct_messages/welcome_messages/rules/list.json", queryParams);
  }
  async setWelcomeDm(welcomeMessageId, deleteAssociatedWelcomeDmWhenDeletingRule = true) {
    var _a;
    const existingRules = await this.listWelcomeDmRules();
    if ((_a = existingRules.welcome_message_rules) === null || _a === undefined ? undefined : _a.length) {
      for (const rule of existingRules.welcome_message_rules) {
        await this.deleteWelcomeDmRule(rule.id);
        if (deleteAssociatedWelcomeDmWhenDeletingRule) {
          await this.deleteWelcomeDm(rule.welcome_message_id);
        }
      }
    }
    return this.newWelcomeDmRule(welcomeMessageId);
  }
  markDmAsRead(lastEventId, recipientId) {
    return this.post("direct_messages/mark_read.json", {
      last_read_event_id: lastEventId,
      recipient_id: recipientId
    }, { forceBodyMode: "url" });
  }
  indicateDmTyping(recipientId) {
    return this.post("direct_messages/indicate_typing.json", {
      recipient_id: recipientId
    }, { forceBodyMode: "url" });
  }
  async downloadDmImage(urlOrDm) {
    if (typeof urlOrDm !== "string") {
      const attachment = urlOrDm[EDirectMessageEventTypeV1.Create].message_data.attachment;
      if (!attachment) {
        throw new Error("The given direct message doesn't contain any attachment");
      }
      urlOrDm = attachment.media.media_url_https;
    }
    const data = await this.get(urlOrDm, undefined, { forceParseMode: "buffer", prefix: "" });
    if (!data.length) {
      throw new Error("Image not found. Make sure you are logged with credentials able to access direct messages, and check the URL.");
    }
    return data;
  }
}
var client_v1_default = TwitterApiv1;

// node_modules/twitter-api-v2/dist/esm/v2/includes.v2.helper.js
class TwitterV2IncludesHelper {
  constructor(result) {
    this.result = result;
  }
  get tweets() {
    return TwitterV2IncludesHelper.tweets(this.result);
  }
  static tweets(result) {
    var _a, _b;
    return (_b = (_a = result.includes) === null || _a === undefined ? undefined : _a.tweets) !== null && _b !== undefined ? _b : [];
  }
  tweetById(id) {
    return TwitterV2IncludesHelper.tweetById(this.result, id);
  }
  static tweetById(result, id) {
    return this.tweets(result).find((tweet) => tweet.id === id);
  }
  retweet(tweet) {
    return TwitterV2IncludesHelper.retweet(this.result, tweet);
  }
  static retweet(result, tweet) {
    var _a;
    const retweetIds = ((_a = tweet.referenced_tweets) !== null && _a !== undefined ? _a : []).filter((ref) => ref.type === "retweeted").map((ref) => ref.id);
    return this.tweets(result).find((t) => retweetIds.includes(t.id));
  }
  quote(tweet) {
    return TwitterV2IncludesHelper.quote(this.result, tweet);
  }
  static quote(result, tweet) {
    var _a;
    const quoteIds = ((_a = tweet.referenced_tweets) !== null && _a !== undefined ? _a : []).filter((ref) => ref.type === "quoted").map((ref) => ref.id);
    return this.tweets(result).find((t) => quoteIds.includes(t.id));
  }
  repliedTo(tweet) {
    return TwitterV2IncludesHelper.repliedTo(this.result, tweet);
  }
  static repliedTo(result, tweet) {
    var _a;
    const repliesIds = ((_a = tweet.referenced_tweets) !== null && _a !== undefined ? _a : []).filter((ref) => ref.type === "replied_to").map((ref) => ref.id);
    return this.tweets(result).find((t) => repliesIds.includes(t.id));
  }
  author(tweet) {
    return TwitterV2IncludesHelper.author(this.result, tweet);
  }
  static author(result, tweet) {
    const authorId = tweet.author_id;
    return authorId ? this.users(result).find((u) => u.id === authorId) : undefined;
  }
  repliedToAuthor(tweet) {
    return TwitterV2IncludesHelper.repliedToAuthor(this.result, tweet);
  }
  static repliedToAuthor(result, tweet) {
    const inReplyUserId = tweet.in_reply_to_user_id;
    return inReplyUserId ? this.users(result).find((u) => u.id === inReplyUserId) : undefined;
  }
  get users() {
    return TwitterV2IncludesHelper.users(this.result);
  }
  static users(result) {
    var _a, _b;
    return (_b = (_a = result.includes) === null || _a === undefined ? undefined : _a.users) !== null && _b !== undefined ? _b : [];
  }
  userById(id) {
    return TwitterV2IncludesHelper.userById(this.result, id);
  }
  static userById(result, id) {
    return this.users(result).find((u) => u.id === id);
  }
  pinnedTweet(user) {
    return TwitterV2IncludesHelper.pinnedTweet(this.result, user);
  }
  static pinnedTweet(result, user) {
    return user.pinned_tweet_id ? this.tweets(result).find((t) => t.id === user.pinned_tweet_id) : undefined;
  }
  get media() {
    return TwitterV2IncludesHelper.media(this.result);
  }
  static media(result) {
    var _a, _b;
    return (_b = (_a = result.includes) === null || _a === undefined ? undefined : _a.media) !== null && _b !== undefined ? _b : [];
  }
  medias(tweet) {
    return TwitterV2IncludesHelper.medias(this.result, tweet);
  }
  static medias(result, tweet) {
    var _a, _b;
    const keys = (_b = (_a = tweet.attachments) === null || _a === undefined ? undefined : _a.media_keys) !== null && _b !== undefined ? _b : [];
    return this.media(result).filter((m) => keys.includes(m.media_key));
  }
  get polls() {
    return TwitterV2IncludesHelper.polls(this.result);
  }
  static polls(result) {
    var _a, _b;
    return (_b = (_a = result.includes) === null || _a === undefined ? undefined : _a.polls) !== null && _b !== undefined ? _b : [];
  }
  poll(tweet) {
    return TwitterV2IncludesHelper.poll(this.result, tweet);
  }
  static poll(result, tweet) {
    var _a, _b;
    const pollIds = (_b = (_a = tweet.attachments) === null || _a === undefined ? undefined : _a.poll_ids) !== null && _b !== undefined ? _b : [];
    if (pollIds.length) {
      const pollId = pollIds[0];
      return this.polls(result).find((p) => p.id === pollId);
    }
    return;
  }
  get places() {
    return TwitterV2IncludesHelper.places(this.result);
  }
  static places(result) {
    var _a, _b;
    return (_b = (_a = result.includes) === null || _a === undefined ? undefined : _a.places) !== null && _b !== undefined ? _b : [];
  }
  place(tweet) {
    return TwitterV2IncludesHelper.place(this.result, tweet);
  }
  static place(result, tweet) {
    var _a;
    const placeId = (_a = tweet.geo) === null || _a === undefined ? undefined : _a.place_id;
    return placeId ? this.places(result).find((p) => p.id === placeId) : undefined;
  }
  listOwner(list) {
    return TwitterV2IncludesHelper.listOwner(this.result, list);
  }
  static listOwner(result, list) {
    const creatorId = list.owner_id;
    return creatorId ? this.users(result).find((p) => p.id === creatorId) : undefined;
  }
  spaceCreator(space) {
    return TwitterV2IncludesHelper.spaceCreator(this.result, space);
  }
  static spaceCreator(result, space) {
    const creatorId = space.creator_id;
    return creatorId ? this.users(result).find((p) => p.id === creatorId) : undefined;
  }
  spaceHosts(space) {
    return TwitterV2IncludesHelper.spaceHosts(this.result, space);
  }
  static spaceHosts(result, space) {
    var _a;
    const hostIds = (_a = space.host_ids) !== null && _a !== undefined ? _a : [];
    return this.users(result).filter((u) => hostIds.includes(u.id));
  }
  spaceSpeakers(space) {
    return TwitterV2IncludesHelper.spaceSpeakers(this.result, space);
  }
  static spaceSpeakers(result, space) {
    var _a;
    const speakerIds = (_a = space.speaker_ids) !== null && _a !== undefined ? _a : [];
    return this.users(result).filter((u) => speakerIds.includes(u.id));
  }
  spaceInvitedUsers(space) {
    return TwitterV2IncludesHelper.spaceInvitedUsers(this.result, space);
  }
  static spaceInvitedUsers(result, space) {
    var _a;
    const invitedUserIds = (_a = space.invited_user_ids) !== null && _a !== undefined ? _a : [];
    return this.users(result).filter((u) => invitedUserIds.includes(u.id));
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/v2.paginator.js
class TwitterV2Paginator extends PreviousableTwitterPaginator {
  updateIncludes(data) {
    if (data.errors) {
      if (!this._realData.errors) {
        this._realData.errors = [];
      }
      this._realData.errors = [...this._realData.errors, ...data.errors];
    }
    if (!data.includes) {
      return;
    }
    if (!this._realData.includes) {
      this._realData.includes = {};
    }
    const includesRealData = this._realData.includes;
    for (const [includeKey, includeArray] of Object.entries(data.includes)) {
      if (!includesRealData[includeKey]) {
        includesRealData[includeKey] = [];
      }
      includesRealData[includeKey] = [
        ...includesRealData[includeKey],
        ...includeArray
      ];
    }
  }
  assertUsable() {
    if (this.unusable) {
      throw new Error("Unable to use this paginator to fetch more data, as it does not contain any metadata." + " Check .errors property for more details.");
    }
  }
  get meta() {
    return this._realData.meta;
  }
  get includes() {
    var _a;
    if (!((_a = this._realData) === null || _a === undefined ? undefined : _a.includes)) {
      return new TwitterV2IncludesHelper(this._realData);
    }
    if (this._includesInstance) {
      return this._includesInstance;
    }
    return this._includesInstance = new TwitterV2IncludesHelper(this._realData);
  }
  get errors() {
    var _a;
    return (_a = this._realData.errors) !== null && _a !== undefined ? _a : [];
  }
  get unusable() {
    return this.errors.length > 0 && !this._realData.meta && !this._realData.data;
  }
}

class TimelineV2Paginator extends TwitterV2Paginator {
  refreshInstanceFromResult(response, isNextPage) {
    var _a;
    const result = response.data;
    const resultData = (_a = result.data) !== null && _a !== undefined ? _a : [];
    this._rateLimit = response.rateLimit;
    if (!this._realData.data) {
      this._realData.data = [];
    }
    if (isNextPage) {
      this._realData.meta.result_count += result.meta.result_count;
      this._realData.meta.next_token = result.meta.next_token;
      this._realData.data.push(...resultData);
    } else {
      this._realData.meta.result_count += result.meta.result_count;
      this._realData.meta.previous_token = result.meta.previous_token;
      this._realData.data.unshift(...resultData);
    }
    this.updateIncludes(result);
  }
  getNextQueryParams(maxResults) {
    this.assertUsable();
    return {
      ...this.injectQueryParams(maxResults),
      pagination_token: this._realData.meta.next_token
    };
  }
  getPreviousQueryParams(maxResults) {
    this.assertUsable();
    return {
      ...this.injectQueryParams(maxResults),
      pagination_token: this._realData.meta.previous_token
    };
  }
  getPageLengthFromRequest(result) {
    var _a, _b;
    return (_b = (_a = result.data.data) === null || _a === undefined ? undefined : _a.length) !== null && _b !== undefined ? _b : 0;
  }
  isFetchLastOver(result) {
    var _a;
    return !((_a = result.data.data) === null || _a === undefined ? undefined : _a.length) || !this.canFetchNextPage(result.data);
  }
  canFetchNextPage(result) {
    var _a;
    return !!((_a = result.meta) === null || _a === undefined ? undefined : _a.next_token);
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/tweet.paginator.v2.js
class TweetTimelineV2Paginator extends TwitterV2Paginator {
  refreshInstanceFromResult(response, isNextPage) {
    var _a;
    const result = response.data;
    const resultData = (_a = result.data) !== null && _a !== undefined ? _a : [];
    this._rateLimit = response.rateLimit;
    if (!this._realData.data) {
      this._realData.data = [];
    }
    if (isNextPage) {
      this._realData.meta.oldest_id = result.meta.oldest_id;
      this._realData.meta.result_count += result.meta.result_count;
      this._realData.meta.next_token = result.meta.next_token;
      this._realData.data.push(...resultData);
    } else {
      this._realData.meta.newest_id = result.meta.newest_id;
      this._realData.meta.result_count += result.meta.result_count;
      this._realData.data.unshift(...resultData);
    }
    this.updateIncludes(result);
  }
  getNextQueryParams(maxResults) {
    this.assertUsable();
    const params = { ...this.injectQueryParams(maxResults) };
    if (this._realData.meta.next_token) {
      params.next_token = this._realData.meta.next_token;
    } else {
      if (params.start_time) {
        params.since_id = this.dateStringToSnowflakeId(params.start_time);
        delete params.start_time;
      }
      if (params.end_time) {
        delete params.end_time;
      }
      params.until_id = this._realData.meta.oldest_id;
    }
    return params;
  }
  getPreviousQueryParams(maxResults) {
    this.assertUsable();
    return {
      ...this.injectQueryParams(maxResults),
      since_id: this._realData.meta.newest_id
    };
  }
  getPageLengthFromRequest(result) {
    var _a, _b;
    return (_b = (_a = result.data.data) === null || _a === undefined ? undefined : _a.length) !== null && _b !== undefined ? _b : 0;
  }
  isFetchLastOver(result) {
    var _a;
    return !((_a = result.data.data) === null || _a === undefined ? undefined : _a.length) || !this.canFetchNextPage(result.data);
  }
  canFetchNextPage(result) {
    return !!result.meta.next_token;
  }
  getItemArray() {
    return this.tweets;
  }
  dateStringToSnowflakeId(dateStr) {
    const TWITTER_START_EPOCH = BigInt("1288834974657");
    const date = new Date(dateStr);
    if (isNaN(date.valueOf())) {
      throw new Error("Unable to convert start_time/end_time to a valid date. A ISO 8601 DateTime is excepted, please check your input.");
    }
    const dateTimestamp = BigInt(date.valueOf());
    return (dateTimestamp - TWITTER_START_EPOCH << BigInt("22")).toString();
  }
  get tweets() {
    var _a;
    return (_a = this._realData.data) !== null && _a !== undefined ? _a : [];
  }
  get meta() {
    return super.meta;
  }
}

class TweetPaginableTimelineV2Paginator extends TimelineV2Paginator {
  refreshInstanceFromResult(response, isNextPage) {
    super.refreshInstanceFromResult(response, isNextPage);
    const result = response.data;
    if (isNextPage) {
      this._realData.meta.oldest_id = result.meta.oldest_id;
    } else {
      this._realData.meta.newest_id = result.meta.newest_id;
    }
  }
  getItemArray() {
    return this.tweets;
  }
  get tweets() {
    var _a;
    return (_a = this._realData.data) !== null && _a !== undefined ? _a : [];
  }
  get meta() {
    return super.meta;
  }
}

class TweetSearchRecentV2Paginator extends TweetTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "tweets/search/recent";
  }
}

class TweetSearchAllV2Paginator extends TweetTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "tweets/search/all";
  }
}

class QuotedTweetsTimelineV2Paginator extends TweetPaginableTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "tweets/:id/quote_tweets";
  }
}

class TweetHomeTimelineV2Paginator extends TweetPaginableTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/timelines/reverse_chronological";
  }
}

class TweetUserTimelineV2Paginator extends TweetPaginableTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/tweets";
  }
}

class TweetUserMentionTimelineV2Paginator extends TweetPaginableTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/mentions";
  }
}

class TweetBookmarksTimelineV2Paginator extends TweetPaginableTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/bookmarks";
  }
}

class TweetListV2Paginator extends TimelineV2Paginator {
  get tweets() {
    var _a;
    return (_a = this._realData.data) !== null && _a !== undefined ? _a : [];
  }
  get meta() {
    return super.meta;
  }
  getItemArray() {
    return this.tweets;
  }
}

class TweetV2UserLikedTweetsPaginator extends TweetListV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/liked_tweets";
  }
}

class TweetV2ListTweetsPaginator extends TweetListV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/:id/tweets";
  }
}
// node_modules/twitter-api-v2/dist/esm/paginators/user.paginator.v2.js
class UserTimelineV2Paginator extends TimelineV2Paginator {
  getItemArray() {
    return this.users;
  }
  get users() {
    var _a;
    return (_a = this._realData.data) !== null && _a !== undefined ? _a : [];
  }
  get meta() {
    return super.meta;
  }
}

class UserBlockingUsersV2Paginator extends UserTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/blocking";
  }
}

class UserMutingUsersV2Paginator extends UserTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/muting";
  }
}

class UserFollowersV2Paginator extends UserTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/followers";
  }
}

class UserFollowingV2Paginator extends UserTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/following";
  }
}

class UserListMembersV2Paginator extends UserTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/:id/members";
  }
}

class UserListFollowersV2Paginator extends UserTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "lists/:id/followers";
  }
}

class TweetLikingUsersV2Paginator extends UserTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "tweets/:id/liking_users";
  }
}

class TweetRetweetersUsersV2Paginator extends UserTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "tweets/:id/retweeted_by";
  }
}
// node_modules/twitter-api-v2/dist/esm/paginators/list.paginator.v2.js
class ListTimelineV2Paginator extends TimelineV2Paginator {
  getItemArray() {
    return this.lists;
  }
  get lists() {
    var _a;
    return (_a = this._realData.data) !== null && _a !== undefined ? _a : [];
  }
  get meta() {
    return super.meta;
  }
}

class UserOwnedListsV2Paginator extends ListTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/owned_lists";
  }
}

class UserListMembershipsV2Paginator extends ListTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/list_memberships";
  }
}

class UserListFollowedV2Paginator extends ListTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "users/:id/followed_lists";
  }
}
// node_modules/twitter-api-v2/dist/esm/v2-labs/client.v2.labs.read.js
class TwitterApiv2LabsReadOnly extends TwitterApiSubClient {
  constructor() {
    super(...arguments);
    this._prefix = API_V2_LABS_PREFIX;
  }
}

// node_modules/twitter-api-v2/dist/esm/paginators/dm.paginator.v2.js
class DMTimelineV2Paginator extends TimelineV2Paginator {
  getItemArray() {
    return this.events;
  }
  get events() {
    var _a;
    return (_a = this._realData.data) !== null && _a !== undefined ? _a : [];
  }
  get meta() {
    return super.meta;
  }
}

class FullDMTimelineV2Paginator extends DMTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "dm_events";
  }
}

class OneToOneDMTimelineV2Paginator extends DMTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "dm_conversations/with/:participant_id/dm_events";
  }
}

class ConversationDMTimelineV2Paginator extends DMTimelineV2Paginator {
  constructor() {
    super(...arguments);
    this._endpoint = "dm_conversations/:dm_conversation_id/dm_events";
  }
}

// node_modules/twitter-api-v2/dist/esm/v2/client.v2.read.js
class TwitterApiv2ReadOnly extends TwitterApiSubClient {
  constructor() {
    super(...arguments);
    this._prefix = API_V2_PREFIX;
  }
  get labs() {
    if (this._labs)
      return this._labs;
    return this._labs = new TwitterApiv2LabsReadOnly(this);
  }
  async search(queryOrOptions, options = {}) {
    const queryParams = typeof queryOrOptions === "string" ? { ...options, query: queryOrOptions } : { ...queryOrOptions };
    const initialRq = await this.get("tweets/search/recent", queryParams, { fullResponse: true });
    return new TweetSearchRecentV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  async searchAll(query, options = {}) {
    const queryParams = { ...options, query };
    const initialRq = await this.get("tweets/search/all", queryParams, { fullResponse: true });
    return new TweetSearchAllV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams
    });
  }
  singleTweet(tweetId, options = {}) {
    return this.get("tweets/:id", options, { params: { id: tweetId } });
  }
  tweets(tweetIds, options = {}) {
    return this.get("tweets", { ids: tweetIds, ...options });
  }
  tweetCountRecent(query, options = {}) {
    return this.get("tweets/counts/recent", { query, ...options });
  }
  tweetCountAll(query, options = {}) {
    return this.get("tweets/counts/all", { query, ...options });
  }
  async tweetRetweetedBy(tweetId, options = {}) {
    const { asPaginator, ...parameters } = options;
    const initialRq = await this.get("tweets/:id/retweeted_by", parameters, {
      fullResponse: true,
      params: { id: tweetId }
    });
    if (!asPaginator) {
      return initialRq.data;
    }
    return new TweetRetweetersUsersV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: parameters,
      sharedParams: { id: tweetId }
    });
  }
  async tweetLikedBy(tweetId, options = {}) {
    const { asPaginator, ...parameters } = options;
    const initialRq = await this.get("tweets/:id/liking_users", parameters, {
      fullResponse: true,
      params: { id: tweetId }
    });
    if (!asPaginator) {
      return initialRq.data;
    }
    return new TweetLikingUsersV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: parameters,
      sharedParams: { id: tweetId }
    });
  }
  async homeTimeline(options = {}) {
    const meUser = await this.getCurrentUserV2Object();
    const initialRq = await this.get("users/:id/timelines/reverse_chronological", options, {
      fullResponse: true,
      params: { id: meUser.data.id }
    });
    return new TweetHomeTimelineV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: options,
      sharedParams: { id: meUser.data.id }
    });
  }
  async userTimeline(userId, options = {}) {
    const initialRq = await this.get("users/:id/tweets", options, {
      fullResponse: true,
      params: { id: userId }
    });
    return new TweetUserTimelineV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: options,
      sharedParams: { id: userId }
    });
  }
  async userMentionTimeline(userId, options = {}) {
    const initialRq = await this.get("users/:id/mentions", options, {
      fullResponse: true,
      params: { id: userId }
    });
    return new TweetUserMentionTimelineV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: options,
      sharedParams: { id: userId }
    });
  }
  async quotes(tweetId, options = {}) {
    const initialRq = await this.get("tweets/:id/quote_tweets", options, {
      fullResponse: true,
      params: { id: tweetId }
    });
    return new QuotedTweetsTimelineV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: options,
      sharedParams: { id: tweetId }
    });
  }
  async bookmarks(options = {}) {
    const user = await this.getCurrentUserV2Object();
    const initialRq = await this.get("users/:id/bookmarks", options, {
      fullResponse: true,
      params: { id: user.data.id }
    });
    return new TweetBookmarksTimelineV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: options,
      sharedParams: { id: user.data.id }
    });
  }
  me(options = {}) {
    return this.get("users/me", options);
  }
  user(userId, options = {}) {
    return this.get("users/:id", options, { params: { id: userId } });
  }
  users(userIds, options = {}) {
    const ids = Array.isArray(userIds) ? userIds.join(",") : userIds;
    return this.get("users", { ...options, ids });
  }
  userByUsername(username, options = {}) {
    return this.get("users/by/username/:username", options, { params: { username } });
  }
  usersByUsernames(usernames, options = {}) {
    usernames = Array.isArray(usernames) ? usernames.join(",") : usernames;
    return this.get("users/by", { ...options, usernames });
  }
  async followers(userId, options = {}) {
    const { asPaginator, ...parameters } = options;
    const params = { id: userId };
    if (!asPaginator) {
      return this.get("users/:id/followers", parameters, { params });
    }
    const initialRq = await this.get("users/:id/followers", parameters, { fullResponse: true, params });
    return new UserFollowersV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: parameters,
      sharedParams: params
    });
  }
  async following(userId, options = {}) {
    const { asPaginator, ...parameters } = options;
    const params = { id: userId };
    if (!asPaginator) {
      return this.get("users/:id/following", parameters, { params });
    }
    const initialRq = await this.get("users/:id/following", parameters, { fullResponse: true, params });
    return new UserFollowingV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: parameters,
      sharedParams: params
    });
  }
  async userLikedTweets(userId, options = {}) {
    const params = { id: userId };
    const initialRq = await this.get("users/:id/liked_tweets", options, { fullResponse: true, params });
    return new TweetV2UserLikedTweetsPaginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async userBlockingUsers(userId, options = {}) {
    const params = { id: userId };
    const initialRq = await this.get("users/:id/blocking", options, { fullResponse: true, params });
    return new UserBlockingUsersV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async userMutingUsers(userId, options = {}) {
    const params = { id: userId };
    const initialRq = await this.get("users/:id/muting", options, { fullResponse: true, params });
    return new UserMutingUsersV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  list(id, options = {}) {
    return this.get("lists/:id", options, { params: { id } });
  }
  async listsOwned(userId, options = {}) {
    const params = { id: userId };
    const initialRq = await this.get("users/:id/owned_lists", options, { fullResponse: true, params });
    return new UserOwnedListsV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async listMemberships(userId, options = {}) {
    const params = { id: userId };
    const initialRq = await this.get("users/:id/list_memberships", options, { fullResponse: true, params });
    return new UserListMembershipsV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async listFollowed(userId, options = {}) {
    const params = { id: userId };
    const initialRq = await this.get("users/:id/followed_lists", options, { fullResponse: true, params });
    return new UserListFollowedV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async listTweets(listId, options = {}) {
    const params = { id: listId };
    const initialRq = await this.get("lists/:id/tweets", options, { fullResponse: true, params });
    return new TweetV2ListTweetsPaginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async listMembers(listId, options = {}) {
    const params = { id: listId };
    const initialRq = await this.get("lists/:id/members", options, { fullResponse: true, params });
    return new UserListMembersV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async listFollowers(listId, options = {}) {
    const params = { id: listId };
    const initialRq = await this.get("lists/:id/followers", options, { fullResponse: true, params });
    return new UserListFollowersV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async listDmEvents(options = {}) {
    const initialRq = await this.get("dm_events", options, { fullResponse: true });
    return new FullDMTimelineV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options }
    });
  }
  async listDmEventsWithParticipant(participantId, options = {}) {
    const params = { participant_id: participantId };
    const initialRq = await this.get("dm_conversations/with/:participant_id/dm_events", options, { fullResponse: true, params });
    return new OneToOneDMTimelineV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  async listDmEventsOfConversation(dmConversationId, options = {}) {
    const params = { dm_conversation_id: dmConversationId };
    const initialRq = await this.get("dm_conversations/:dm_conversation_id/dm_events", options, { fullResponse: true, params });
    return new ConversationDMTimelineV2Paginator({
      realData: initialRq.data,
      rateLimit: initialRq.rateLimit,
      instance: this,
      queryParams: { ...options },
      sharedParams: params
    });
  }
  space(spaceId, options = {}) {
    return this.get("spaces/:id", options, { params: { id: spaceId } });
  }
  spaces(spaceIds, options = {}) {
    return this.get("spaces", { ids: spaceIds, ...options });
  }
  spacesByCreators(creatorIds, options = {}) {
    return this.get("spaces/by/creator_ids", { user_ids: creatorIds, ...options });
  }
  searchSpaces(options) {
    return this.get("spaces/search", options);
  }
  spaceBuyers(spaceId, options = {}) {
    return this.get("spaces/:id/buyers", options, { params: { id: spaceId } });
  }
  spaceTweets(spaceId, options = {}) {
    return this.get("spaces/:id/tweets", options, { params: { id: spaceId } });
  }
  searchStream({ autoConnect, ...options } = {}) {
    return this.getStream("tweets/search/stream", options, { payloadIsError: isTweetStreamV2ErrorPayload, autoConnect });
  }
  streamRules(options = {}) {
    return this.get("tweets/search/stream/rules", options);
  }
  updateStreamRules(options, query = {}) {
    return this.post("tweets/search/stream/rules", options, { query });
  }
  sampleStream({ autoConnect, ...options } = {}) {
    return this.getStream("tweets/sample/stream", options, { payloadIsError: isTweetStreamV2ErrorPayload, autoConnect });
  }
  sample10Stream({ autoConnect, ...options } = {}) {
    return this.getStream("tweets/sample10/stream", options, { payloadIsError: isTweetStreamV2ErrorPayload, autoConnect });
  }
  complianceJobs(options) {
    return this.get("compliance/jobs", options);
  }
  complianceJob(jobId) {
    return this.get("compliance/jobs/:id", undefined, { params: { id: jobId } });
  }
  async sendComplianceJob(jobParams) {
    const job = await this.post("compliance/jobs", { type: jobParams.type, name: jobParams.name });
    const rawIdsBody = jobParams.ids instanceof Buffer ? jobParams.ids : Buffer.from(jobParams.ids.join(`
`));
    await this.put(job.data.upload_url, rawIdsBody, {
      forceBodyMode: "raw",
      enableAuth: false,
      headers: { "Content-Type": "text/plain" },
      prefix: ""
    });
    return job;
  }
  async complianceJobResult(job) {
    let runningJob = job;
    while (runningJob.status !== "complete") {
      if (runningJob.status === "expired" || runningJob.status === "failed") {
        throw new Error("Job failed to be completed.");
      }
      await new Promise((resolve) => setTimeout(resolve, 3500));
      runningJob = (await this.complianceJob(job.id)).data;
    }
    const result = await this.get(job.download_url, undefined, {
      enableAuth: false,
      prefix: ""
    });
    return result.trim().split(`
`).filter((line) => line).map((line) => JSON.parse(line));
  }
  async usage(options = {}) {
    return this.get("usage/tweets", options);
  }
  community(communityId, options = {}) {
    return this.get("communities/:id", options, { params: { id: communityId } });
  }
  searchCommunities(query, options = {}) {
    return this.get("communities/search", { query, ...options });
  }
}

// node_modules/twitter-api-v2/dist/esm/v2-labs/client.v2.labs.write.js
class TwitterApiv2LabsReadWrite extends TwitterApiv2LabsReadOnly {
  constructor() {
    super(...arguments);
    this._prefix = API_V2_LABS_PREFIX;
  }
  get readOnly() {
    return this;
  }
}

// node_modules/twitter-api-v2/dist/esm/v2/client.v2.write.js
class TwitterApiv2ReadWrite extends TwitterApiv2ReadOnly {
  constructor() {
    super(...arguments);
    this._prefix = API_V2_PREFIX;
  }
  get readOnly() {
    return this;
  }
  get labs() {
    if (this._labs)
      return this._labs;
    return this._labs = new TwitterApiv2LabsReadWrite(this);
  }
  hideReply(tweetId, makeHidden) {
    return this.put("tweets/:id/hidden", { hidden: makeHidden }, { params: { id: tweetId } });
  }
  like(loggedUserId, targetTweetId) {
    return this.post("users/:id/likes", { tweet_id: targetTweetId }, { params: { id: loggedUserId } });
  }
  unlike(loggedUserId, targetTweetId) {
    return this.delete("users/:id/likes/:tweet_id", undefined, {
      params: { id: loggedUserId, tweet_id: targetTweetId }
    });
  }
  retweet(loggedUserId, targetTweetId) {
    return this.post("users/:id/retweets", { tweet_id: targetTweetId }, { params: { id: loggedUserId } });
  }
  unretweet(loggedUserId, targetTweetId) {
    return this.delete("users/:id/retweets/:tweet_id", undefined, {
      params: { id: loggedUserId, tweet_id: targetTweetId }
    });
  }
  tweet(status, payload = {}) {
    if (typeof status === "object") {
      payload = status;
    } else {
      payload = { text: status, ...payload };
    }
    return this.post("tweets", payload);
  }
  async uploadMedia(media, options, chunkSize = 1024 * 1024) {
    let media_category = options.media_category;
    if (!options.media_category) {
      if (options.media_type.includes("gif")) {
        media_category = "tweet_gif";
      } else if (options.media_type.includes("image")) {
        media_category = "tweet_image";
      } else if (options.media_type.includes("video")) {
        media_category = "tweet_video";
      }
    }
    const initArguments = {
      additional_owners: options.additional_owners,
      media_type: options.media_type,
      total_bytes: media.length,
      media_category
    };
    const initResponse = await this.post("media/upload/initialize", initArguments);
    const mediaId = initResponse.data.id;
    const chunksCount = Math.ceil(media.length / chunkSize);
    const mediaArray = new Uint8Array(media);
    for (let i = 0;i < chunksCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, media.length);
      const mediaChunk = mediaArray.slice(start, end);
      const chunkedBuffer = Buffer.from(mediaChunk);
      const appendArguments = {
        segment_index: i,
        media: chunkedBuffer
      };
      await this.post(`media/upload/${mediaId}/append`, appendArguments, { forceBodyMode: "form-data" });
    }
    const finalizeResponse = await this.post(`media/upload/${mediaId}/finalize`);
    if (finalizeResponse.data.processing_info) {
      await this.waitForMediaProcessing(mediaId);
    }
    return mediaId;
  }
  async waitForMediaProcessing(mediaId) {
    var _a;
    const response = await this.get("media/upload", {
      command: "STATUS",
      media_id: mediaId
    });
    const info = response.data.processing_info;
    if (!info)
      return;
    switch (info.state) {
      case "succeeded":
        return;
      case "failed":
        throw new Error(`Media processing failed: ${(_a = info.error) === null || _a === undefined ? undefined : _a.message}`);
      case "pending":
      case "in_progress": {
        const waitTime = info === null || info === undefined ? undefined : info.check_after_secs;
        if (waitTime && waitTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
          await this.waitForMediaProcessing(mediaId);
        }
      }
    }
  }
  createMediaMetadata(mediaId, metadata) {
    return this.post("media/metadata", { id: mediaId, metadata });
  }
  reply(status, toTweetId, payload = {}) {
    var _a;
    const reply = { in_reply_to_tweet_id: toTweetId, ...(_a = payload.reply) !== null && _a !== undefined ? _a : {} };
    return this.post("tweets", { text: status, ...payload, reply });
  }
  quote(status, quotedTweetId, payload = {}) {
    return this.tweet(status, { ...payload, quote_tweet_id: quotedTweetId });
  }
  async tweetThread(tweets) {
    var _a, _b;
    const postedTweets = [];
    for (const tweet of tweets) {
      const lastTweet = postedTweets.length ? postedTweets[postedTweets.length - 1] : null;
      const queryParams = { ...typeof tweet === "string" ? { text: tweet } : tweet };
      const inReplyToId = lastTweet ? lastTweet.data.id : (_a = queryParams.reply) === null || _a === undefined ? undefined : _a.in_reply_to_tweet_id;
      const status = (_b = queryParams.text) !== null && _b !== undefined ? _b : "";
      if (inReplyToId) {
        postedTweets.push(await this.reply(status, inReplyToId, queryParams));
      } else {
        postedTweets.push(await this.tweet(status, queryParams));
      }
    }
    return postedTweets;
  }
  deleteTweet(tweetId) {
    return this.delete("tweets/:id", undefined, {
      params: {
        id: tweetId
      }
    });
  }
  async bookmark(tweetId) {
    const user = await this.getCurrentUserV2Object();
    return this.post("users/:id/bookmarks", { tweet_id: tweetId }, { params: { id: user.data.id } });
  }
  async deleteBookmark(tweetId) {
    const user = await this.getCurrentUserV2Object();
    return this.delete("users/:id/bookmarks/:tweet_id", undefined, { params: { id: user.data.id, tweet_id: tweetId } });
  }
  follow(loggedUserId, targetUserId) {
    return this.post("users/:id/following", { target_user_id: targetUserId }, { params: { id: loggedUserId } });
  }
  unfollow(loggedUserId, targetUserId) {
    return this.delete("users/:source_user_id/following/:target_user_id", undefined, {
      params: { source_user_id: loggedUserId, target_user_id: targetUserId }
    });
  }
  block(loggedUserId, targetUserId) {
    return this.post("users/:id/blocking", { target_user_id: targetUserId }, { params: { id: loggedUserId } });
  }
  unblock(loggedUserId, targetUserId) {
    return this.delete("users/:source_user_id/blocking/:target_user_id", undefined, {
      params: { source_user_id: loggedUserId, target_user_id: targetUserId }
    });
  }
  mute(loggedUserId, targetUserId) {
    return this.post("users/:id/muting", { target_user_id: targetUserId }, { params: { id: loggedUserId } });
  }
  unmute(loggedUserId, targetUserId) {
    return this.delete("users/:source_user_id/muting/:target_user_id", undefined, {
      params: { source_user_id: loggedUserId, target_user_id: targetUserId }
    });
  }
  createList(options) {
    return this.post("lists", options);
  }
  updateList(listId, options = {}) {
    return this.put("lists/:id", options, { params: { id: listId } });
  }
  removeList(listId) {
    return this.delete("lists/:id", undefined, { params: { id: listId } });
  }
  addListMember(listId, userId) {
    return this.post("lists/:id/members", { user_id: userId }, { params: { id: listId } });
  }
  removeListMember(listId, userId) {
    return this.delete("lists/:id/members/:user_id", undefined, { params: { id: listId, user_id: userId } });
  }
  subscribeToList(loggedUserId, listId) {
    return this.post("users/:id/followed_lists", { list_id: listId }, { params: { id: loggedUserId } });
  }
  unsubscribeOfList(loggedUserId, listId) {
    return this.delete("users/:id/followed_lists/:list_id", undefined, { params: { id: loggedUserId, list_id: listId } });
  }
  pinList(loggedUserId, listId) {
    return this.post("users/:id/pinned_lists", { list_id: listId }, { params: { id: loggedUserId } });
  }
  unpinList(loggedUserId, listId) {
    return this.delete("users/:id/pinned_lists/:list_id", undefined, { params: { id: loggedUserId, list_id: listId } });
  }
  sendDmInConversation(conversationId, message) {
    return this.post("dm_conversations/:dm_conversation_id/messages", message, { params: { dm_conversation_id: conversationId } });
  }
  sendDmToParticipant(participantId, message) {
    return this.post("dm_conversations/with/:participant_id/messages", message, { params: { participant_id: participantId } });
  }
  createDmConversation(options) {
    return this.post("dm_conversations", options);
  }
}

// node_modules/twitter-api-v2/dist/esm/v2-labs/client.v2.labs.js
class TwitterApiv2Labs extends TwitterApiv2LabsReadWrite {
  constructor() {
    super(...arguments);
    this._prefix = API_V2_LABS_PREFIX;
  }
  get readWrite() {
    return this;
  }
}
var client_v2_labs_default = TwitterApiv2Labs;

// node_modules/twitter-api-v2/dist/esm/v2/client.v2.js
class TwitterApiv2 extends TwitterApiv2ReadWrite {
  constructor() {
    super(...arguments);
    this._prefix = API_V2_PREFIX;
  }
  get readWrite() {
    return this;
  }
  get labs() {
    if (this._labs)
      return this._labs;
    return this._labs = new client_v2_labs_default(this);
  }
}
var client_v2_default = TwitterApiv2;

// node_modules/twitter-api-v2/dist/esm/client/readonly.js
class TwitterApiReadOnly extends TwitterApiBase {
  get v1() {
    if (this._v1)
      return this._v1;
    return this._v1 = new TwitterApiv1ReadOnly(this);
  }
  get v2() {
    if (this._v2)
      return this._v2;
    return this._v2 = new TwitterApiv2ReadOnly(this);
  }
  async currentUser(forceFetch = false) {
    return await this.getCurrentUserObject(forceFetch);
  }
  async currentUserV2(forceFetch = false) {
    return await this.getCurrentUserV2Object(forceFetch);
  }
  search(what, options) {
    return this.v2.search(what, options);
  }
  async generateAuthLink(oauth_callback = "oob", { authAccessType, linkMode = "authenticate", forceLogin, screenName } = {}) {
    const oauthResult = await this.post("https://api.x.com/oauth/request_token", { oauth_callback, x_auth_access_type: authAccessType });
    let url = `https://api.x.com/oauth/${linkMode}?oauth_token=${encodeURIComponent(oauthResult.oauth_token)}`;
    if (forceLogin !== undefined) {
      url += `&force_login=${encodeURIComponent(forceLogin)}`;
    }
    if (screenName !== undefined) {
      url += `&screen_name=${encodeURIComponent(screenName)}`;
    }
    if (this._requestMaker.hasPlugins()) {
      this._requestMaker.applyPluginMethod("onOAuth1RequestToken", {
        client: this._requestMaker,
        url,
        oauthResult
      });
    }
    return {
      url,
      ...oauthResult
    };
  }
  async login(oauth_verifier) {
    const tokens = this.getActiveTokens();
    if (tokens.type !== "oauth-1.0a")
      throw new Error("You must setup TwitterApi instance with consumer keys to accept OAuth 1.0 login");
    const oauth_result = await this.post("https://api.x.com/oauth/access_token", { oauth_token: tokens.accessToken, oauth_verifier });
    const client2 = new this.constructor({
      appKey: tokens.appKey,
      appSecret: tokens.appSecret,
      accessToken: oauth_result.oauth_token,
      accessSecret: oauth_result.oauth_token_secret
    }, this._requestMaker.clientSettings);
    return {
      accessToken: oauth_result.oauth_token,
      accessSecret: oauth_result.oauth_token_secret,
      userId: oauth_result.user_id,
      screenName: oauth_result.screen_name,
      client: client2
    };
  }
  async appLogin() {
    const tokens = this.getActiveTokens();
    if (tokens.type !== "oauth-1.0a")
      throw new Error("You must setup TwitterApi instance with consumer keys to accept app-only login");
    const basicClient = new this.constructor({ username: tokens.appKey, password: tokens.appSecret }, this._requestMaker.clientSettings);
    const res = await basicClient.post("https://api.x.com/oauth2/token", { grant_type: "client_credentials" });
    return new this.constructor(res.access_token, this._requestMaker.clientSettings);
  }
  generateOAuth2AuthLink(redirectUri, options = {}) {
    var _a, _b;
    if (!this._requestMaker.clientId) {
      throw new Error("Twitter API instance is not initialized with client ID. You can find your client ID in Twitter Developer Portal. " + "Please build an instance with: new TwitterApi({ clientId: '<yourClientId>' })");
    }
    const state = (_a = options.state) !== null && _a !== undefined ? _a : OAuth2Helper.generateRandomString(32);
    const codeVerifier = OAuth2Helper.getCodeVerifier();
    const codeChallenge = OAuth2Helper.getCodeChallengeFromVerifier(codeVerifier);
    const rawScope = (_b = options.scope) !== null && _b !== undefined ? _b : "";
    const scope = Array.isArray(rawScope) ? rawScope.join(" ") : rawScope;
    const url = new URL("https://x.com/i/oauth2/authorize");
    const query = {
      response_type: "code",
      client_id: this._requestMaker.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "s256",
      scope
    };
    request_param_helper_default.addQueryParamsToUrl(url, query);
    const result = {
      url: url.toString(),
      state,
      codeVerifier,
      codeChallenge
    };
    if (this._requestMaker.hasPlugins()) {
      this._requestMaker.applyPluginMethod("onOAuth2RequestToken", {
        client: this._requestMaker,
        result,
        redirectUri
      });
    }
    return result;
  }
  async loginWithOAuth2({ code, codeVerifier, redirectUri }) {
    if (!this._requestMaker.clientId) {
      throw new Error("Twitter API instance is not initialized with client ID. " + "Please build an instance with: new TwitterApi({ clientId: '<yourClientId>' })");
    }
    const accessTokenResult = await this.post("https://api.x.com/2/oauth2/token", {
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      client_id: this._requestMaker.clientId,
      client_secret: this._requestMaker.clientSecret
    });
    return this.parseOAuth2AccessTokenResult(accessTokenResult);
  }
  async refreshOAuth2Token(refreshToken) {
    if (!this._requestMaker.clientId) {
      throw new Error("Twitter API instance is not initialized with client ID. " + "Please build an instance with: new TwitterApi({ clientId: '<yourClientId>' })");
    }
    const accessTokenResult = await this.post("https://api.x.com/2/oauth2/token", {
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      client_id: this._requestMaker.clientId,
      client_secret: this._requestMaker.clientSecret
    });
    return this.parseOAuth2AccessTokenResult(accessTokenResult);
  }
  async revokeOAuth2Token(token, tokenType = "access_token") {
    if (!this._requestMaker.clientId) {
      throw new Error("Twitter API instance is not initialized with client ID. " + "Please build an instance with: new TwitterApi({ clientId: '<yourClientId>' })");
    }
    return await this.post("https://api.x.com/2/oauth2/revoke", {
      client_id: this._requestMaker.clientId,
      client_secret: this._requestMaker.clientSecret,
      token,
      token_type_hint: tokenType
    });
  }
  parseOAuth2AccessTokenResult(result) {
    const client2 = new this.constructor(result.access_token, this._requestMaker.clientSettings);
    const scope = result.scope.split(" ").filter((e) => e);
    return {
      client: client2,
      expiresIn: result.expires_in,
      accessToken: result.access_token,
      scope,
      refreshToken: result.refresh_token
    };
  }
}

// node_modules/twitter-api-v2/dist/esm/client/readwrite.js
class TwitterApiReadWrite extends TwitterApiReadOnly {
  get v1() {
    if (this._v1)
      return this._v1;
    return this._v1 = new TwitterApiv1ReadWrite(this);
  }
  get v2() {
    if (this._v2)
      return this._v2;
    return this._v2 = new TwitterApiv2ReadWrite(this);
  }
  get readOnly() {
    return this;
  }
}

// node_modules/twitter-api-v2/dist/esm/ads/client.ads.read.js
class TwitterAdsReadOnly extends TwitterApiSubClient {
  constructor() {
    super(...arguments);
    this._prefix = API_ADS_PREFIX;
  }
}

// node_modules/twitter-api-v2/dist/esm/ads/client.ads.write.js
class TwitterAdsReadWrite extends TwitterAdsReadOnly {
  constructor() {
    super(...arguments);
    this._prefix = API_ADS_PREFIX;
  }
  get readOnly() {
    return this;
  }
}

// node_modules/twitter-api-v2/dist/esm/ads-sandbox/client.ads-sandbox.read.js
class TwitterAdsSandboxReadOnly extends TwitterApiSubClient {
  constructor() {
    super(...arguments);
    this._prefix = API_ADS_SANDBOX_PREFIX;
  }
}

// node_modules/twitter-api-v2/dist/esm/ads-sandbox/client.ads-sandbox.write.js
class TwitterAdsSandboxReadWrite extends TwitterAdsSandboxReadOnly {
  constructor() {
    super(...arguments);
    this._prefix = API_ADS_SANDBOX_PREFIX;
  }
  get readOnly() {
    return this;
  }
}

// node_modules/twitter-api-v2/dist/esm/ads-sandbox/client.ads-sandbox.js
class TwitterAdsSandbox extends TwitterAdsSandboxReadWrite {
  constructor() {
    super(...arguments);
    this._prefix = API_ADS_SANDBOX_PREFIX;
  }
  get readWrite() {
    return this;
  }
}
var client_ads_sandbox_default = TwitterAdsSandbox;

// node_modules/twitter-api-v2/dist/esm/ads/client.ads.js
class TwitterAds extends TwitterAdsReadWrite {
  constructor() {
    super(...arguments);
    this._prefix = API_ADS_PREFIX;
  }
  get readWrite() {
    return this;
  }
  get sandbox() {
    if (this._sandbox)
      return this._sandbox;
    return this._sandbox = new client_ads_sandbox_default(this);
  }
}
var client_ads_default = TwitterAds;

// node_modules/twitter-api-v2/dist/esm/client/index.js
class TwitterApi extends TwitterApiReadWrite {
  get v1() {
    if (this._v1)
      return this._v1;
    return this._v1 = new client_v1_default(this);
  }
  get v2() {
    if (this._v2)
      return this._v2;
    return this._v2 = new client_v2_default(this);
  }
  get readWrite() {
    return this;
  }
  get ads() {
    if (this._ads)
      return this._ads;
    return this._ads = new client_ads_default(this);
  }
  static getErrors(error) {
    var _a;
    if (typeof error !== "object")
      return [];
    if (!("data" in error))
      return [];
    return (_a = error.data.errors) !== null && _a !== undefined ? _a : [];
  }
  static getProfileImageInSize(profileImageUrl, size) {
    const lastPart = profileImageUrl.split("/").pop();
    const sizes = ["normal", "bigger", "mini"];
    let originalUrl = profileImageUrl;
    for (const availableSize of sizes) {
      if (lastPart.includes(`_${availableSize}`)) {
        originalUrl = profileImageUrl.replace(`_${availableSize}`, "");
        break;
      }
    }
    if (size === "original") {
      return originalUrl;
    }
    const extPos = originalUrl.lastIndexOf(".");
    if (extPos !== -1) {
      const ext = originalUrl.slice(extPos + 1);
      return originalUrl.slice(0, extPos) + "_" + size + "." + ext;
    } else {
      return originalUrl + "_" + size;
    }
  }
}
// src/index.ts
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
async function tursoExecute(url, token, sql, args = []) {
  const httpUrl = url.replace(/^libsql:\/\//, "https://");
  const res = await fetch(`${httpUrl}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql, args } },
        { type: "close" }
      ]
    })
  });
  if (!res.ok) {
    throw new Error(`turso HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const first = data.results?.[0];
  if (!first)
    throw new Error("turso: empty results");
  if (first.type === "error") {
    throw new Error(`turso error: ${first.error?.message || JSON.stringify(first.error)}`);
  }
  return first.response.result;
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FAILED: missing environment variable ${name}`);
    process.exit(2);
  }
  return v;
}
function parsePostedAt(raw) {
  let iso = raw.trim();
  if (iso.length === 10) {
    iso = `${iso}T00:00:00Z`;
  } else if (iso.includes(" ") && !iso.includes("T")) {
    iso = `${iso.replace(" ", "T")}Z`;
  } else if (!iso.endsWith("Z") && !/[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso = `${iso}Z`;
  }
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  return { days, iso };
}
function canonicalToSnakeCase(name) {
  return name.toLowerCase().replace(/\s+/g, "_");
}
var SERIES_DIR_TO_NAME = {
  "agent-swarm-runs": "AgentSwarm",
  "foundation-runs": "Foundation",
  "levelup-runs": "LevelUp",
  "vibe-runs": "Vibe"
};
function seriesNameFromDir(dir) {
  const mapped = SERIES_DIR_TO_NAME[dir];
  if (mapped)
    return mapped;
  return dir.replace(/-runs$/, "").split(/[-_]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}
function buildOpts() {
  const program2 = new Command;
  program2.name("meme-post").description("Post an imgflip meme as a tweet (default) or generate a blog hero image, with hard guardrails (cooldown, box-count, always-log).").option("--target <mode>", "tweet | blog (default: tweet)", "tweet").requiredOption("--template <name>", 'meme template name \u2014 canonical (e.g. "Expanding Brain") or snake_case (e.g. "expanding_brain"); resolves to x-posts.meme_templates.name').option("--captions <list>", "separator-delimited captions, one per box (tweet target: comma-separated; blog target: pipe-separated)").option("--caption <text...>", "repeated caption flag (use instead of --captions when captions contain the separator)").option("--text <body>", "tweet text body (required for --target tweet)").option("--post-type <type>", "post_type tag for x-posts.posts (tweet target)", "daily-meme-tweet").option("--series-dir <name>", "blog series directory (e.g. agent-swarm-runs, foundation-runs, levelup-runs, vibe-runs) \u2014 required for --target blog").option("--run-id <id>", "blog run id (typically date YYYY-MM-DD) \u2014 required for --target blog").option("--style-category <name>", "style category passthrough for image_prompt_history (blog target)").option("--force", "bypass the 14-day cooldown check", false).option("--dry-run", "skip the side-effect step (tweet+INSERT for tweet target; agent-fs upload + INSERT for blog target). Still calls imgflip.", false).allowExcessArguments(false).parse(process.argv);
  return program2.opts();
}
function resolveCaptions(opts, separator) {
  const captionsRaw = opts.captions;
  const captionList = opts.caption;
  if (captionsRaw && captionList && captionList.length > 0) {
    console.error("FAILED: pass --captions OR repeated --caption, not both");
    process.exit(2);
  }
  if (captionList && captionList.length > 0)
    return captionList;
  if (captionsRaw !== undefined) {
    return captionsRaw.split(separator).map((s) => s.trim());
  }
  return [];
}
async function lookupTemplate(tursoUrl, tursoToken, rawName) {
  const res = await tursoExecute(tursoUrl, tursoToken, "SELECT id, name, box_count FROM meme_templates WHERE LOWER(REPLACE(name, '_', ' ')) = LOWER(REPLACE(?, '_', ' ')) LIMIT 1;", [{ type: "text", value: rawName }]);
  if (res.rows.length === 0)
    return null;
  return {
    id: res.rows[0][0].value,
    canonicalName: res.rows[0][1].value,
    boxCount: parseInt(res.rows[0][2].value, 10)
  };
}
async function imgflipCaption(templateId, captions, imgflipUser, imgflipPass) {
  const params = new URLSearchParams;
  params.set("template_id", templateId);
  params.set("username", imgflipUser);
  params.set("password", imgflipPass);
  for (let i = 0;i < captions.length; i++) {
    params.append(`boxes[${i}][text]`, captions[i]);
  }
  const res = await fetch("https://api.imgflip.com/caption_image", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await res.json();
  if (!data?.success) {
    throw new Error(`imgflip error: ${data?.error_message ?? "unknown"}`);
  }
  return data.data.url;
}
async function runTweet(opts) {
  const template = String(opts.template);
  const tweetText = opts.text != null ? String(opts.text) : "";
  if (!tweetText) {
    console.error("FAILED: --text is required for --target tweet");
    process.exit(2);
  }
  const postType = String(opts.postType ?? "daily-meme-tweet");
  const force = Boolean(opts.force);
  const dryRun = Boolean(opts.dryRun);
  const captions = resolveCaptions(opts, ",");
  if (captions.length === 0) {
    console.error('FAILED: at least one caption is required (use --captions "a,b" or repeated --caption)');
    process.exit(2);
  }
  const tursoUrl = requireEnv("TURSO_X_POSTS_DB_URL");
  const tursoToken = requireEnv("TURSO_X_POSTS_DB_TOKEN");
  const imgflipUser = requireEnv("IMGFLIP_USERNAME");
  const imgflipPass = requireEnv("IMGFLIP_PASSWORD");
  let cooldownBypassed = false;
  if (force) {
    cooldownBypassed = true;
  } else {
    const cooldown = await tursoExecute(tursoUrl, tursoToken, "SELECT posted_at FROM posts WHERE meme_template_name = ? AND post_type = ? AND posted_at > datetime('now', '-14 days') ORDER BY posted_at DESC LIMIT 1;", [
      { type: "text", value: template },
      { type: "text", value: postType }
    ]);
    if (cooldown.rows.length > 0) {
      const postedAt = cooldown.rows[0][0].value;
      const { days, iso } = parsePostedAt(postedAt);
      console.error(`FAILED: template "${template}" was used ${days} day(s) ago at ${iso}. Re-run with --force to override.`);
      process.exit(1);
    }
  }
  const tplRes = await tursoExecute(tursoUrl, tursoToken, "SELECT id, box_count FROM meme_templates WHERE name = ? LIMIT 1;", [{ type: "text", value: template }]);
  if (tplRes.rows.length === 0) {
    console.error(`FAILED: template "${template}" not found in meme_templates`);
    process.exit(1);
  }
  const templateId = tplRes.rows[0][0].value;
  const boxCount = parseInt(tplRes.rows[0][1].value, 10);
  if (captions.length < boxCount) {
    console.error(`FAILED: template "${template}" requires ${boxCount} captions, got ${captions.length}.`);
    process.exit(1);
  }
  let memeUrl;
  try {
    memeUrl = await imgflipCaption(templateId, captions.slice(0, boxCount), imgflipUser, imgflipPass);
  } catch (err) {
    console.error(`FAILED: ${err?.message ?? err}`);
    process.exit(1);
  }
  if (dryRun) {
    console.log(JSON.stringify({
      tweet_url: null,
      meme_url: memeUrl,
      template_name: template,
      box_count: boxCount,
      captions,
      cooldown_bypassed: cooldownBypassed,
      logged_to_posts: false,
      dry_run: true
    }));
    return;
  }
  const xKey = requireEnv("X_API_KEY");
  const xSecret = requireEnv("X_API_SECRET");
  const xAccessToken = requireEnv("X_ACCESS_TOKEN");
  const xAccessSecret = requireEnv("X_ACCESS_TOKEN_SECRET");
  const client5 = new TwitterApi({
    appKey: xKey,
    appSecret: xSecret,
    accessToken: xAccessToken,
    accessSecret: xAccessSecret
  });
  const imgResp = await fetch(memeUrl);
  if (!imgResp.ok)
    throw new Error(`download meme failed: HTTP ${imgResp.status}`);
  const buf = Buffer.from(await imgResp.arrayBuffer());
  const ext = (memeUrl.split(".").pop() || "jpg").split("?")[0];
  const tmpPath = join(tmpdir(), `meme-post-${Date.now()}.${ext}`);
  await writeFile(tmpPath, buf);
  let tweetId;
  let tweetUrl;
  try {
    const mediaId = await client5.v1.uploadMedia(tmpPath);
    const tweetRes = await client5.v2.tweet({
      text: tweetText,
      media: { media_ids: [mediaId] }
    });
    tweetId = tweetRes.data.id;
    tweetUrl = `https://x.com/desplegalabs/status/${tweetId}`;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
  const textPreview = tweetText.length > 200 ? tweetText.slice(0, 200) : tweetText;
  await tursoExecute(tursoUrl, tursoToken, "INSERT INTO posts (tweet_id, tweet_url, text_preview, post_type, content_type, has_meme, meme_template_name, meme_url, posted_at) VALUES (?, ?, ?, ?, 'meme', 1, ?, ?, datetime('now'));", [
    { type: "text", value: tweetId },
    { type: "text", value: tweetUrl },
    { type: "text", value: textPreview },
    { type: "text", value: postType },
    { type: "text", value: template },
    { type: "text", value: memeUrl }
  ]);
  const verify = await tursoExecute(tursoUrl, tursoToken, "SELECT id FROM posts WHERE tweet_id = ? LIMIT 1;", [{ type: "text", value: tweetId }]);
  if (verify.rows.length === 0) {
    console.error(`FAILED: tweet ${tweetId} did not land in posts table after INSERT`);
    process.exit(3);
  }
  console.log(JSON.stringify({
    tweet_url: tweetUrl,
    meme_url: memeUrl,
    template_name: template,
    box_count: boxCount,
    captions,
    cooldown_bypassed: cooldownBypassed,
    logged_to_posts: true
  }));
}
function emitBlogError(error, extra = {}) {
  console.log(JSON.stringify({ imageUrl: "", error, ...extra }));
  process.exit(2);
}
async function uploadImageResultJson(args) {
  const path = `${args.seriesDir}/${args.runId}/image-result.json`;
  const content = JSON.stringify(args.payload);
  const res = await fetch(`${args.afsUrl}/orgs/${args.afsOrgId}/ops`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.afsKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      op: "write",
      path,
      content,
      message: `Blog hero meme generated (${args.seriesDir} ${args.runId})`
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`agent-fs upload HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return path;
}
async function runBlog(opts) {
  const seriesDir = opts.seriesDir != null ? String(opts.seriesDir) : "";
  const runId = opts.runId != null ? String(opts.runId) : "";
  if (!seriesDir) {
    emitBlogError("missing_series_dir", { hint: "--series-dir is required for --target blog (e.g. agent-swarm-runs)" });
  }
  if (!runId) {
    emitBlogError("missing_run_id", { hint: "--run-id is required for --target blog (typically YYYY-MM-DD)" });
  }
  const rawTemplate = String(opts.template);
  const force = Boolean(opts.force);
  const dryRun = Boolean(opts.dryRun);
  const styleCategory = opts.styleCategory != null ? String(opts.styleCategory) : "";
  const captions = resolveCaptions(opts, "|");
  if (captions.length === 0) {
    emitBlogError("missing_captions", { hint: 'pass --captions "a|b|..." or repeated --caption' });
  }
  const xPostsUrl = requireEnv("TURSO_X_POSTS_DB_URL");
  const xPostsToken = requireEnv("TURSO_X_POSTS_DB_TOKEN");
  const contentUrl = requireEnv("CONTENT_STATE_DB_URL");
  const contentToken = requireEnv("CONTENT_STATE_DB_TOKEN");
  const imgflipUser = requireEnv("IMGFLIP_USERNAME");
  const imgflipPass = requireEnv("IMGFLIP_PASSWORD");
  const afsUrl = requireEnv("AGENT_FS_API_URL");
  const afsKey = requireEnv("AGENT_FS_API_KEY");
  const afsOrgId = process.env.AGENT_FS_SHARED_ORG_ID ?? "648a5f3c-35c8-4f11-8673-b89de52cd6bd";
  const tpl = await lookupTemplate(xPostsUrl, xPostsToken, rawTemplate);
  if (!tpl) {
    emitBlogError("unknown_template", {
      template_input: rawTemplate,
      hint: "must match x-posts.meme_templates.name (case-insensitive + underscores\u2194spaces)"
    });
  }
  const templateKey = canonicalToSnakeCase(tpl.canonicalName);
  const seriesName = seriesNameFromDir(seriesDir);
  if (captions.length !== tpl.boxCount) {
    emitBlogError("caption_count_mismatch", {
      template_name: tpl.canonicalName,
      template_key: templateKey,
      box_count: tpl.boxCount,
      captions_provided: captions.length,
      hint: "the imgflip request must have exactly box_count captions \u2014 a half-filled multi-panel meme is a structural failure"
    });
  }
  let cooldownBypassed = false;
  if (force) {
    cooldownBypassed = true;
  } else {
    const cd = await tursoExecute(contentUrl, contentToken, "SELECT template_name, generation_date FROM image_prompt_history WHERE template_name = ? COLLATE NOCASE AND series = ? AND generation_date > date('now', '-14 days') ORDER BY generation_date DESC LIMIT 1;", [
      { type: "text", value: templateKey },
      { type: "text", value: seriesName }
    ]);
    if (cd.rows.length > 0) {
      const lastDate = cd.rows[0][1].value;
      const { days, iso } = parsePostedAt(lastDate);
      console.error(`FAILED: template "${templateKey}" was used in series "${seriesName}" ${days} day(s) ago at ${iso}. Re-run with --force to override.`);
      emitBlogError("cooldown", {
        template_name: tpl.canonicalName,
        template_key: templateKey,
        series: seriesName,
        days_since_last_use: days,
        last_generation_date: iso,
        hint: "pass --force to override"
      });
    }
  }
  let memeUrl;
  try {
    memeUrl = await imgflipCaption(tpl.id, captions, imgflipUser, imgflipPass);
  } catch (err) {
    emitBlogError("imgflip_failed", {
      template_name: tpl.canonicalName,
      template_key: templateKey,
      reason: err?.message ?? String(err)
    });
  }
  const baseOutput = {
    imageUrl: memeUrl,
    template: templateKey,
    style_category: styleCategory,
    template_name: tpl.canonicalName,
    box_count: tpl.boxCount,
    captions,
    target: "blog",
    series_dir: seriesDir,
    series: seriesName,
    run_id: runId,
    meme_url: memeUrl
  };
  if (dryRun) {
    console.log(JSON.stringify({
      ...baseOutput,
      agent_fs_url: null,
      logged: false,
      forced: cooldownBypassed,
      dry_run: true
    }));
    return;
  }
  let afsPath;
  try {
    afsPath = await uploadImageResultJson({
      afsUrl,
      afsKey,
      afsOrgId,
      seriesDir,
      runId,
      payload: {
        imageUrl: memeUrl,
        style_category: styleCategory,
        template: templateKey
      }
    });
  } catch (err) {
    emitBlogError("agent_fs_upload_failed", {
      template_name: tpl.canonicalName,
      template_key: templateKey,
      reason: err?.message ?? String(err),
      meme_url: memeUrl
    });
  }
  const promptSummary = captions.join(" | ").slice(0, 500);
  try {
    await tursoExecute(contentUrl, contentToken, "INSERT INTO image_prompt_history (prompt, series, style_category, generation_date, template_name, blog_slug) VALUES (?, ?, ?, date('now'), ?, NULL);", [
      { type: "text", value: promptSummary },
      { type: "text", value: seriesName },
      { type: "text", value: styleCategory },
      { type: "text", value: templateKey }
    ]);
  } catch (err) {
    emitBlogError("insert_failed", {
      template_name: tpl.canonicalName,
      template_key: templateKey,
      reason: err?.message ?? String(err),
      meme_url: memeUrl,
      agent_fs_url: afsPath
    });
  }
  const verify = await tursoExecute(contentUrl, contentToken, "SELECT template_name FROM image_prompt_history WHERE template_name = ? COLLATE NOCASE AND series = ? AND generation_date = date('now') ORDER BY rowid DESC LIMIT 1;", [
    { type: "text", value: templateKey },
    { type: "text", value: seriesName }
  ]);
  if (verify.rows.length === 0) {
    emitBlogError("verify_failed", {
      template_name: tpl.canonicalName,
      template_key: templateKey,
      series: seriesName,
      meme_url: memeUrl,
      agent_fs_url: afsPath,
      hint: "INSERT returned OK but SELECT did not find the row \u2014 cooldown will be blind tomorrow"
    });
  }
  console.log(JSON.stringify({
    ...baseOutput,
    agent_fs_url: afsPath,
    logged: true,
    forced: cooldownBypassed
  }));
}
async function main() {
  const opts = buildOpts();
  const target = String(opts.target ?? "tweet").toLowerCase();
  if (target === "tweet") {
    await runTweet(opts);
    return;
  }
  if (target === "blog") {
    await runBlog(opts);
    return;
  }
  console.error(`FAILED: unknown --target "${target}" (expected tweet|blog)`);
  process.exit(2);
}
main().catch((err) => {
  console.error(`FAILED: ${err?.message ?? err}`);
  process.exit(2);
});
