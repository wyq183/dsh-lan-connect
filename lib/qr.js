/**
 * qr.js —— 零依赖 QR Code（Model 2 / ISO-IEC 18004）编码模块
 * ---------------------------------------------------------------------------
 * 设计目标：
 *   · 纯 JavaScript ESM，无任何外部依赖，Node 20+ 可直接 `import` 使用；
 *   · 仅实现 byte mode（字节模式，文本按 UTF-8 编码），纠错等级支持 'L' 与 'M'；
 *   · 版本（version 1 ~ 40）自动选择，取能装下数据的最小版本；
 *   · 掩码（mask 0~7）按 ISO/IEC 18004 的四条惩罚规则自动择优。
 *
 * 对外导出：
 *   qrMatrix(text, ecLevel = 'M')  -> boolean[][]   深色模块为 true，不含静默区
 *   qrSvg(text, options = {})      -> string        完整 SVG 文本
 *
 * 说明：本文件所用纠错分块表、格式信息生成、惩罚评分等均来自 ISO/IEC 18004
 *      规范本身（公开标准常量与算法），逐条对照 4.2 验证通过。
 */

/* ===========================================================================
 * 一、标准常量表
 * ========================================================================= */

/**
 * 每个纠错块的纠错码字数（ECC codewords per block）。
 * 下标 = 版本号（1~40），下标 0 为占位（非法值 -1）。
 * 只列 'L' 与 'M' 两级；数据来自 ISO/IEC 18004 表 13-22。
 */
const ECC_CODEWORDS_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};

/**
 * 纠错块数量（number of error correction blocks）。
 * 下标 = 版本号（1~40），下标 0 为占位。
 */
const NUM_ERROR_CORRECTION_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};

/**
 * 纠错等级 -> 格式信息中的 2 bit 指示符。
 * 规范表 25：L = 01，M = 00（Q = 11，H = 10，本模块未实现）。
 */
const EC_FORMAT_BITS = { L: 1, M: 0 };

/** 支持纠错等级的白名单（便于统一校验与报错）。 */
const SUPPORTED_EC_LEVELS = Object.keys(EC_FORMAT_BITS);

/** 版本范围：QR Code Model 2 支持 1~40。 */
const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** byte mode 的模式指示符（4 bit）。 */
const MODE_BYTE = 0b0100;

/** 四条惩罚规则的权重（规范 8.8.2 表 24）。 */
const PENALTY_N1 = 3; // 同色连续 5 个及以上
const PENALTY_N2 = 3; // 2x2 同色块
const PENALTY_N3 = 40; // 出现 1:1:3:1:1 类定位图形
const PENALTY_N4 = 10; // 深色比例偏离 50%

/** 填充码字（规范 8.4.9）：0xEC、0x11 交替。 */
const PAD_BYTE_A = 0xec;
const PAD_BYTE_B = 0x11;

/* ===========================================================================
 * 二、基础工具函数
 * ========================================================================= */

/** 把 UTF-8 文本编码成字节数组（TextEncoder 是 Node/浏览器内置全局对象，无依赖）。 */
function toUtf8Bytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

/**
 * 把 val 的低 len 位依次压入位数组 bits（高位在前）。
 * 例：appendBits(0b0100, 4, bits) 会压入 0,1,0,0。
 */
function appendBits(val, len, bits) {
  if (len < 0 || len > 31 || val >>> len !== 0) {
    throw new RangeError('appendBits: 数值超出指定位宽');
  }
  for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
}

/** 取整数 x 的第 i 位（0 = 最低位）。 */
function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

/** 校验并归一化纠错等级（大小写不敏感）。 */
function normalizeEcLevel(ecLevel) {
  const name = String(ecLevel ?? 'M').toUpperCase();
  if (!SUPPORTED_EC_LEVELS.includes(name)) {
    throw new RangeError(`不支持的纠错等级 "${ecLevel}"，本模块仅支持 L / M`);
  }
  return name;
}

/* ===========================================================================
 * 三、容量与分块计算
 * ========================================================================= */

/**
 * 计算某版本除去功能图形后，可用于数据（含纠错码与剩余位）的模块数。
 * 结果不一定被 8 整除——余下的就是“剩余位 remainder bits”。
 */
function getNumRawDataModules(version) {
  if (version < MIN_VERSION || version > MAX_VERSION) {
    throw new RangeError('版本号超出 1~40 范围');
  }
  // 全图模块数，再逐个扣掉定位图形、分隔符、校正图形、格式/版本信息区
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36; // 版本信息区（两个 6x3）
  }
  return result;
}

/** 某版本 + 某纠错等级下，真正承载数据的码字数（8 bit 为 1 码字，丢弃剩余位）。 */
function getNumDataCodewords(version, ecLevel) {
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecLevel][version] * NUM_ERROR_CORRECTION_BLOCKS[ecLevel][version]
  );
}

/**
 * byte mode 下字符计数字段的位宽：
 *   版本 1~9    -> 8 bit
 *   版本 10~26  -> 16 bit
 *   版本 27~40  -> 16 bit
 * （规范表 3；byte mode 只用到 8 / 16 两种。）
 */
function byteModeCharCountBits(version) {
  return version <= 9 ? 8 : 16;
}

/** 估算 byte mode 在指定版本下所需的总位数（装不下则返回 Infinity）。 */
function byteTotalBits(byteLen, version) {
  if (byteLen === 0) return 0; // 空串不写 segment（见 buildDataCodewords 注释）
  const ccBits = byteModeCharCountBits(version);
  if (byteLen >= 1 << ccBits) return Infinity; // 字符计数放不下
  return 4 + ccBits + byteLen * 8;
}

/** 自动选择最小可用版本；超出 40 版容量时抛错。 */
function chooseVersion(byteLen, ecLevel) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteTotalBits(byteLen, version) <= getNumDataCodewords(version, ecLevel) * 8) {
      return version;
    }
  }
  throw new RangeError(`数据过长（${byteLen} 字节），QR 版本 1~40 的 ${ecLevel} 级容不下`);
}

/* ===========================================================================
 * 四、数据编码 + Reed-Solomon 纠错 + 交织
 * ========================================================================= */

/**
 * 生成数据码字（不含纠错码）：
 * 模式指示符 -> 字符计数 -> 数据位 -> 终止符 -> 补齐字节边界 -> 填充码字。
 */
function buildDataCodewords(byteLen, bytes, version, ecLevel) {
  const capacityBits = getNumDataCodewords(version, ecLevel) * 8;
  const bits = [];

  // 空串是规范的空白地带：这里采用与 qrcode.react / Nayuki qrcodegen 一致的约定
  // ——不写入任何 segment（连模式指示符都不写），全部由终止符 + 填充码字构成。
  // 解码结果同样是空字符串，且能与本机对照实现逐格一致。
  if (byteLen > 0) {
    appendBits(MODE_BYTE, 4, bits); // 模式指示符 0100
    appendBits(byteLen, byteModeCharCountBits(version), bits); // 字符计数（字节数）
    for (const b of bytes) appendBits(b, 8, bits); // 数据本体
  }

  // 终止符：最多 4 个 0，容量不足时按剩余位数截断
  appendBits(0, Math.min(4, capacityBits - bits.length), bits);
  // 补 0 直到落在字节边界
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);

  // 填充码字 0xEC / 0x11 交替，直到填满数据容量
  for (let pad = PAD_BYTE_A; bits.length < capacityBits; pad ^= PAD_BYTE_A ^ PAD_BYTE_B) {
    appendBits(pad, 8, bits);
  }

  // 位数组打包成码字数组
  const codewords = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, i) => {
    codewords[i >>> 3] |= bit << (7 - (i & 7));
  });
  return codewords;
}

/**
 * 生成 Reed-Solomon 生成多项式的系数（GF(2^8)，本原多项式 0x11D）。
 * degree = 纠错码字数。
 */
function reedSolomonComputeDivisor(degree) {
  if (degree < 1 || degree > 255) throw new RangeError('RS 多项式次数超出范围');
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1; // 从多项式 1 开始，逐次乘 (x - α^i)
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 2);
  }
  return result;
}

/** 计算数据码字的 RS 余数（即纠错码字）。 */
function reedSolomonComputeRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= reedSolomonMultiply(divisor[i], factor);
    }
  }
  return result;
}

/** GF(2^8) 乘法（俄罗斯农民乘法，模 0x11D）。 */
function reedSolomonMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/**
 * 分块加纠错并按规范交织：
 *   1) 把数据码字切成若干块，短块比长块少 1 个数据码字；
 *   2) 每块补上自己的 RS 纠错码字；
 *   3) 按“先所有块的第 1 个码字，再第 2 个……”的顺序交织输出。
 */
function addEccAndInterleave(dataCodewords, version, ecLevel) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecLevel][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecLevel][version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks); // 短块个数
  const shortBlockLen = Math.floor(rawCodewords / numBlocks); // 短块总长度（数据+纠错）

  const rsDivisor = reedSolomonComputeDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    // 长块（i >= numShortBlocks）比短块多 1 个数据码字
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = dataCodewords.slice(k, k + datLen);
    k += dat.length;
    const ecc = reedSolomonComputeRemainder(dat, rsDivisor);
    if (i < numShortBlocks) dat.push(0); // 占位，保证交织时列对齐
    blocks.push(dat.concat(ecc));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // 跳过短块的占位字节
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

/* ===========================================================================
 * 五、矩阵构建（功能图形 / 数据放置 / 掩码）
 * ========================================================================= */

/** 计算本版本校正图形的中心坐标列表（升序）。 */
function getAlignmentPatternPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/** 掩码条件表：输入坐标返回 true 表示该模块需要取反（规范表 10）。 */
const MASK_FUNCTIONS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * 构建最终矩阵。
 * @returns {{ modules: boolean[][], version: number, size: number, mask: number, ecLevel: string }}
 */
function buildMatrix(text, ecLevel) {
  const bytes = toUtf8Bytes(text);
  const byteLen = bytes.length;
  const version = chooseVersion(byteLen, ecLevel);
  const size = version * 4 + 17;

  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  /** 写入一个模块并标记为功能模块（不参与掩码）。 */
  const setFunctionModule = (x, y, isDark) => {
    modules[y][x] = isDark;
    isFunction[y][x] = true;
  };

  /* ---------- 5.1 时序图形（第 6 行 / 第 6 列交替黑白） ---------- */
  for (let i = 0; i < size; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  /* ---------- 5.2 定位图形 + 分隔符（3 个 9x9，含一圈浅色分隔） ---------- */
  const drawFinderPattern = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy)); // 切比雪夫距离
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          setFunctionModule(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  };
  drawFinderPattern(3, 3);
  drawFinderPattern(size - 4, 3);
  drawFinderPattern(3, size - 4);

  /* ---------- 5.3 校正图形（5x5，三个定位图形所在角落除外） ---------- */
  const alignPos = getAlignmentPatternPositions(version);
  const numAlign = alignPos.length;
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      const isCorner =
        (i === 0 && j === 0) ||
        (i === 0 && j === numAlign - 1) ||
        (i === numAlign - 1 && j === 0);
      if (isCorner) continue;
      const cx = alignPos[i];
      const cy = alignPos[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  /* ---------- 5.4 格式信息（含 BCH(15,5) 纠错与固定掩码 0x5412） ---------- */
  const drawFormatBits = (mask) => {
    const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    // 第一份：左上角
    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getBit(bits, i));
    setFunctionModule(8, 7, getBit(bits, 6));
    setFunctionModule(8, 8, getBit(bits, 7));
    setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getBit(bits, i));

    // 第二份：右上角 + 左下角
    for (let i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, getBit(bits, i));

    setFunctionModule(8, size - 8, true); // 固定的深色模块
  };

  /* ---------- 5.5 版本信息（版本 >= 7 才有，BCH(18,6)） ---------- */
  const drawVersionBits = () => {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, color);
      setFunctionModule(b, a, color);
    }
  };

  drawFormatBits(0); // 先占位，稍后按选中的掩码重绘
  drawVersionBits();

  /* ---------- 5.6 数据码字放置（自右下角起，两列一组蛇形向上/向下） ---------- */
  const allCodewords = addEccAndInterleave(
    buildDataCodewords(byteLen, bytes, version, ecLevel),
    version,
    ecLevel,
  );
  {
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过第 6 列（时序图形）
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < allCodewords.length * 8) {
            modules[y][x] = getBit(allCodewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
    if (i !== allCodewords.length * 8) throw new Error('码字放置数量与容量不一致');
  }

  /* ---------- 5.7 掩码 ---------- */
  const applyMask = (mask) => {
    const fn = MASK_FUNCTIONS[mask];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && fn(x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };

  /** 惩罚规则 3 的辅助：把定位图形样式 1:1:3:1:1 的命中数算出来。 */
  const finderPenaltyCountPatterns = (runHistory) => {
    const n = runHistory[1];
    const core =
      n > 0 &&
      runHistory[2] === n &&
      runHistory[3] === n * 3 &&
      runHistory[4] === n &&
      runHistory[5] === n;
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    );
  };
  const finderPenaltyAddHistory = (currentRunLength, runHistory) => {
    if (runHistory[0] === 0) currentRunLength += size; // 视为有静默区
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  };
  const finderPenaltyTerminateAndCount = (currentRunColor, currentRunLength, runHistory) => {
    if (currentRunColor) {
      finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += size;
    finderPenaltyAddHistory(currentRunLength, runHistory);
    return finderPenaltyCountPatterns(runHistory);
  };

  /** 按规范 8.8.2 计算整图惩罚分（越低越好）。 */
  const getPenaltyScore = () => {
    let result = 0;

    // 规则 1（行/列连续同色）+ 规则 3（定位图形样式）
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runLen = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          finderPenaltyAddHistory(runLen, runHistory);
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = modules[y][x];
          runLen = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, runHistory) * PENALTY_N3;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runLen = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          finderPenaltyAddHistory(runLen, runHistory);
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = modules[y][x];
          runLen = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, runHistory) * PENALTY_N3;
    }

    // 规则 2：2x2 同色块
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // 规则 4：深色模块比例偏离 50% 的档数
    let dark = 0;
    for (const row of modules) for (const cell of row) if (cell) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;

    return result;
  };

  // 逐一遍历 8 种掩码，取惩罚分最低者（同分保留编号小的，与规范一致）
  let bestMask = 0;
  let minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask); // 格式信息也参与评分
    const penalty = getPenaltyScore();
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask); // 异或可逆：撤销本次掩码
  }

  applyMask(bestMask);
  drawFormatBits(bestMask);

  return { modules, version, size, mask: bestMask, ecLevel };
}

/* ===========================================================================
 * 六、对外 API
 * ========================================================================= */

/**
 * 生成 QR Code 模块矩阵。
 *
 * @param {string} text       待编码文本（按 UTF-8 转字节，byte mode）
 * @param {'L'|'M'} [ecLevel] 纠错等级，默认 'M'
 * @returns {boolean[][]}     边长 = 4 * version + 17 的二维数组，true = 深色；
 *                            **不含静默区（quiet zone），由调用方自行留白**
 */
export function qrMatrix(text, ecLevel = 'M') {
  if (typeof text !== 'string') throw new TypeError('qrMatrix: text 必须是字符串');
  return buildMatrix(text, normalizeEcLevel(ecLevel)).modules;
}

/**
 * 生成完整 SVG 字符串（含静默区与背景色）。
 *
 * @param {string} text 待编码文本
 * @param {object} [options]
 * @param {number} [options.size=220]       SVG 宽高（像素）
 * @param {number} [options.margin=4]       静默区宽度（单位：模块数，规范建议 >= 4）
 * @param {'L'|'M'} [options.ecLevel='M']   纠错等级
 * @param {string} [options.dark='#000000'] 深色模块颜色
 * @param {string} [options.light='#ffffff']背景色
 * @returns {string} 完整 SVG 文档字符串
 */
export function qrSvg(text, options = {}) {
  const {
    size = 220,
    margin = 4,
    ecLevel = 'M',
    dark = '#000000',
    light = '#ffffff',
  } = options;

  if (typeof text !== 'string') throw new TypeError('qrSvg: text 必须是字符串');
  if (!Number.isFinite(size) || size <= 0) throw new RangeError('qrSvg: size 必须是正数');
  if (!Number.isInteger(margin) || margin < 0) {
    throw new RangeError('qrSvg: margin 必须是非负整数（单位：模块）');
  }

  const modules = qrMatrix(text, ecLevel);
  const dim = modules.length; // 边长（模块数）
  const total = dim + margin * 2; // 含静默区的总模块数，用作 viewBox

  // 把每行连续的深色模块合并成一条水平线段，减少 path 体积
  const ops = [];
  modules.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x++) {
      const isDark = x < row.length ? row[x] : false;
      if (isDark && start < 0) {
        start = x;
      } else if (!isDark && start >= 0) {
        // M<起点x> <y> h<宽度> v1 H<起点x> z —— 一个 1 模块高的矩形
        ops.push(`M${start + margin} ${y + margin}h${x - start}v1H${start + margin}z`);
        start = -1;
      }
    }
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path fill="${dark}" d="${ops.join('')}"/>` +
    `</svg>`
  );
}

export default { qrMatrix, qrSvg };
