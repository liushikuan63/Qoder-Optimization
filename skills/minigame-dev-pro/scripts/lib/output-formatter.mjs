/**
 * 统一输出格式化器（自研）
 *
 * 所有脚本通过此模块输出结果，确保格式一致：
 *  - JSON 模式：输出合法 JSON，供 AI 消费
 *  - 文本模式：输出人类可读格式
 *  - 退出码：成功 0，失败 1
 */

/**
 * 输出成功结果
 * @param {object} data 结果数据
 * @param {boolean} json 是否JSON格式
 */
export function outputSuccess(data, json = false) {
  const result = { ok: true, ...data };
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printReadable(result);
  }
  process.exit(0);
}

/**
 * 输出失败结果
 * @param {string} error 错误信息
 * @param {object} extra 附加信息
 * @param {boolean} json 是否JSON格式
 *
 * ⚠️ 重要：此函数调用后立即 process.exit(1)，不会返回。
 * 调用方在其之后的代码不会执行（属 fail-fast 设计）。
 * 如需"多步降级尝试"，不要用此函数，应自行 throw 或返回错误对象。
 */
export function outputError(error, extra = {}, json = false) {
  const result = { ok: false, error, ...extra };
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stderr.write(`✗ ${error}\n`);
    if (extra.hint) process.stderr.write(`  提示: ${extra.hint}\n`);
  }
  process.exit(1);
}

/**
 * 打印可读格式
 */
function printReadable(result) {
  if (result.ok) {
    process.stdout.write('✓ 操作成功\n');
  }
  for (const [key, value] of Object.entries(result)) {
    if (key === 'ok') continue;
    printField(key, value, 0);
  }
}

function printField(key, value, indent) {
  const prefix = '  '.repeat(indent);
  if (value === null || value === undefined) {
    process.stdout.write(`${prefix}${key}: (无)\n`);
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    process.stdout.write(`${prefix}${key}:\n`);
    for (const [k, v] of Object.entries(value)) {
      printField(k, v, indent + 1);
    }
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      process.stdout.write(`${prefix}${key}: (空)\n`);
    } else {
      process.stdout.write(`${prefix}${key}:\n`);
      value.forEach((item, i) => {
        if (typeof item === 'object') {
          process.stdout.write(`${prefix}  [${i}]\n`);
          for (const [k, v] of Object.entries(item)) {
            printField(k, v, indent + 2);
          }
        } else {
          process.stdout.write(`${prefix}  - ${item}\n`);
        }
      });
    }
  } else {
    process.stdout.write(`${prefix}${key}: ${value}\n`);
  }
}

/**
 * 解析命令行参数
 * 支持：--key value / --key=value / --flag
 * 支持：同名参数多次出现时收集为数组（如--filter a --filter b → filter: ['a','b']）
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        const key = a.slice(2, eq);
        const value = a.slice(eq + 1);
        assignArg(args, key, value);
      } else {
        const key = a.slice(2);
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          assignArg(args, key, argv[i + 1]);
          i++;
        } else {
          args[key] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

/**
 * 赋值参数：同名 key 出现多次时转为数组 */
function assignArg(args, key, value) {
  if (args[key] === undefined) {
    args[key] = value;
  } else if (Array.isArray(args[key])) {
    args[key].push(value);
  } else {
    args[key] = [args[key], value];
  }
}

/**
 * 打印帮助信息
 */
export function printHelp(helpText) {
  process.stdout.write(helpText + '\n');
  process.exit(0);
}

export default { outputSuccess, outputError, parseArgs, printHelp };

