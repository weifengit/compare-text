'use strict';
/**
 * make-xlsx-demo.js — 生成 Excel 对比的测试模板（成对，放 demo/xlsx/）。
 * 运行：node tools/make-xlsx-demo.js
 *
 * 产物（每套都是 旧/新 一对，直接左右选进 compare-text 即可）：
 *   01-单sheet-基础/      最基本：单 sheet、单行表头、增删改齐备
 *   02-多行表头/          两行表头（分组行 + 真实列名），验证「父 / 子」拼接
 *   03-多sheet/           三个 sheet 一次对比（含只在旧文件/只在新文件的 sheet）
 *   04-表头以上内容/      表头上方有标题栏 + 分组行，验证上方内容保留
 *   05-格式还原/          列宽/字号/填充/边框/冻结/合并单元格，验证报告格式还原
 *   06-宽松比较/          日期跨类型、0 与 0.0、浮点尾差，验证不误报
 *   07-无键列哈希/        没有可用键列，退化为整行哈希比对
 *   08-真实业务形态/     109 列的厂区报表形态（缩量），验证宽表
 *
 * 每套目录里还有一个 说明.txt，写了「该看什么」。
 */
var fs = require('fs');
var path = require('path');
var ExcelJS = require(path.join(__dirname, '..', 'lib', 'exceljs.min.js'));

var OUT = path.join(__dirname, '..', 'demo', 'xlsx');

// ---------- 通用：写一个工作簿 ----------
/**
 * sheets = [
 *   { name, above:[[...]], headers:[[...]], rows:[[...]], widths:[], freeze:{}, styles:{...} }
 * ]
 * above  = 表头以上的行（标题栏 / 分组行）
 * headers = 表头行（1 行或多行）
 * rows    = 数据行
 */
function writeBook(file, sheets) {
  var wb = new ExcelJS.Workbook();
  wb.creator = 'compare-text demo';
  wb.created = new Date(2024, 0, 1);

  sheets.forEach(function (spec) {
    var ws = wb.addWorksheet(spec.name);

    // 1) 表头以上
    (spec.above || []).forEach(function (r) {
      var row = ws.addRow(r);
      row.height = spec.aboveHeight || 22;
      row.font = { bold: true, size: 11 };
      row.alignment = { vertical: 'middle' };
    });

    // 2) 表头（可能多行）
    (spec.headers || []).forEach(function (r, hi) {
      var row = ws.addRow(r);
      row.height = spec.headerHeight || 20;
      row.font = { bold: true, size: 10, name: '宋体' };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hi === 0 && spec.headers.length > 1 ? 'FFE8EEF7' : 'FFDDEBF7' } };
      row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      row.eachCell(function (c) { c.border = THIN_BORDER; });
    });

    // 3) 数据
    (spec.rows || []).forEach(function (r, ri) {
      var row = ws.addRow(r);
      row.font = { size: 10, name: '宋体' };
      row.eachCell(function (c) { c.border = THIN_BORDER; });
      // 斑马纹（可选）：让「格式还原」更直观
      if (spec.zebra && ri % 2 === 1) {
        row.eachCell(function (c) {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
        });
      }
    });

    // 4) 列宽
    // 注意：ExcelJS 把「恰等于默认值 9」当成未自定义，<cols> 整段不写出，源文件里
    // 显式设的 9 就丢了。所以这里把 9 抬高一丁点，保证"显式设置"能被保存下来。
    if (spec.widths) {
      spec.widths.forEach(function (w, i) {
        ws.getColumn(i + 1).width = (Math.abs(w - 9) < 1e-9) ? 9.0001 : w;
      });
    }
    if (spec.hiddenCols) {
      spec.hiddenCols.forEach(function (i) { ws.getColumn(i + 1).hidden = true; });
    }

    // 5) 冻结窗格
    if (spec.freeze) ws.views = [spec.freeze];

    // 6) 合并单元格
    if (spec.merges) spec.merges.forEach(function (m) { ws.mergeCells(m); });

    // 7) 某些列指定数字格式（日期列等）
    if (spec.numFmts) {
      spec.numFmts.forEach(function (n) {
        for (var r = n.fromRow; r <= ws.rowCount; r++) {
          ws.getRow(r).getCell(n.col).numFmt = n.fmt;
        }
      });
    }
  });

  return wb.xlsx.writeBuffer().then(function (buf) {
    fs.writeFileSync(file, Buffer.from(buf));
    return file;
  });
}

var THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  right: { style: 'thin', color: { argb: 'FFBFBFBF' } }
};

function mkdirp(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeNote(dir, lines) {
  fs.writeFileSync(path.join(dir, '说明.txt'), lines.join('\n') + '\n', 'utf8');
}

// ---------- 各套模板 ----------

/** 01 单 sheet 基础：增/改/删齐备 */
function case01() {
  var dir = mkdirp(path.join(OUT, '01-单sheet-基础'));
  var HEADERS = [['品名', '批号', '数量', '单价', '金额']];
  var OLD = [
    ['当归', 'D001', 100, 25.5, 2550],
    ['黄芪', 'D002', 200, 18.0, 3600],
    ['党参', 'D003', 150, 32.0, 4800],
    ['甘草', 'D004', 80, 15.5, 1240],
    ['川芎', 'D005', 120, 28.0, 3360]
  ];
  var NEW = [
    ['当归', 'D001', 100, 25.5, 2550],      // 不变
    ['黄芪', 'D002', 200, 19.5, 3900],      // 改：单价 18→19.5，金额 3600→3900
    // D003 被删除
    ['甘草', 'D004', 80, 15.5, 1240],       // 不变
    ['川芎', 'D005', 130, 28.0, 3640],      // 改：数量 120→130
    ['白芍', 'D006', 90, 42.0, 3780]        // 新增
  ];
  var base = { widths: [12, 10, 9, 9, 12], freeze: { state: 'frozen', ySplit: 1 } };
  return Promise.all([
    writeBook(path.join(dir, '旧.xlsx'), [
      { name: '库存', headers: HEADERS, rows: OLD, widths: base.widths, freeze: base.freeze }
    ]),
    writeBook(path.join(dir, '新.xlsx'), [
      { name: '库存', headers: HEADERS, rows: NEW, widths: base.widths, freeze: base.freeze }
    ])
  ]).then(function () {
    writeNote(dir, [
      '【01 单 sheet 基础】',
      '',
      '用途：最基本的一对文件，验证增删改三类都能正确分类。',
      '期望结果（键列选「批号」，或留空让它自动识别）：',
      '  新增 1 行：白芍 D006',
      '  修改 2 行：黄芪 D002（单价、金额 两列变）；川芎 D005（数量变）',
      '  删除 1 行：党参 D003',
      '',
      '观察点：',
      '  · 结果区「修改」视图里，D002 应显示两条「旧值 → 新值」',
      '  · 点「新 3 行」应跳到主区域3 右侧表格并高亮',
      '  · 导出 Excel 后：应有 对比总览 / 库存_新增 / 库存_修改 / 库存_删除'
    ]);
  });
}

/** 02 多行表头 */
function case02() {
  var dir = mkdirp(path.join(OUT, '02-多行表头'));
  var ABOVE = [];
  var HDR1 = ['基本信息', '基本信息', '检验结果', '检验结果', '检验结果'];
  var HDR2 = ['批号', '品名', '水分', '灰分', '含量'];
  var OLD = [
    ['P001', '当归', 8.5, 4.2, 98.5],
    ['P002', '黄芪', 9.1, 4.8, 97.2],
    ['P003', '党参', 7.8, 3.9, 96.8]
  ];
  var NEW = [
    ['P001', '当归', 8.5, 4.2, 98.5],
    ['P002', '黄芪', 6.9, 4.8, 97.2],      // 改：水分 9.1→6.9
    ['P003', '党参', 7.8, 3.9, 95.1],      // 改：含量 96.8→95.1
    ['P004', '甘草', 8.0, 4.0, 99.0]       // 新增
  ];
  var widths = [10, 12, 10, 10, 10];
  var freeze = { state: 'frozen', ySplit: 2 };
  return Promise.all([
    writeBook(path.join(dir, '旧.xlsx'), [{ name: '检验', headers: [HDR1, HDR2], rows: OLD, widths: widths, freeze: freeze, merges: ['A1:B1', 'C1:E1'] }]),
    writeBook(path.join(dir, '新.xlsx'), [{ name: '检验', headers: [HDR1, HDR2], rows: NEW, widths: widths, freeze: freeze, merges: ['A1:B1', 'C1:E1'] }])
  ]).then(function () {
    writeNote(dir, [
      '【02 多行表头】',
      '',
      '用途：表头是**两行**（第1行是分组、第2行是真列名），验证「父 / 子」拼接。',
      '配置要点：表头行填 【起始 1】【结束 2】。',
      '  拼接后列名应变成「基本信息 / 批号」「检验结果 / 含量」这种形式。',
      '  如果只填 1~1，列名会是「基本信息」「基本信息」「检验结果」——重复且不可用。',
      '',
      '期望结果（键列选「基本信息 / 批号」）：',
      '  新增 1 行：P004',
      '  修改 2 行：P002（水分变）、P003（含量变）',
      '  删除 0 行',
      '',
      '观察点：',
      '  · 配置弹窗里两张预览表会把第 1~2 行标成蓝色（表头区）',
      '  · 导出报告的列宽应保留源文件的 10/12/10/10/10'
    ]);
  });
}

/** 03 多 sheet */
function case03() {
  var dir = mkdirp(path.join(OUT, '03-多sheet'));
  var H = [['批号', '品名', '数量']];
  var w = [10, 12, 9];

  function book(extraSheets) {
    var sheets = [
      { name: '原料', headers: H, rows: [['R1', '当归', 100], ['R2', '黄芪', 200], ['R3', '党参', 150]], widths: w },
      { name: '成品', headers: H, rows: [['F1', '当归片', 90], ['F2', '黄芪片', 180]], widths: w }
    ].concat(extraSheets || []);
    return sheets;
  }

  return Promise.all([
    writeBook(path.join(dir, '旧.xlsx'), book([
      // 只在旧文件里的 sheet：应整表记为「删除」
      { name: '已停用', headers: H, rows: [['X1', '旧品种甲', 10], ['X2', '旧品种乙', 20]], widths: w }
    ])),
    writeBook(path.join(dir, '新.xlsx'), book([
      // 只在新文件里的 sheet：应整表记为「新增」
      { name: '新增品种', headers: [['批号', '品名', '数量', '备注']], rows: [['N1', '新品种', 50, '试产']], widths: [10, 12, 9, 16] }
    ]).map(function (s) {
      // 给两个共有 sheet 造一点差异
      if (s.name === '原料') s.rows = [['R1', '当归', 100], ['R2', '黄芪', 220], ['R4', '甘草', 80]];
      if (s.name === '成品') s.rows = [['F1', '当归片', 90], ['F2', '黄芪片', 180]];
      return s;
    }))
  ]).then(function () {
    writeNote(dir, [
      '【03 多 sheet】',
      '',
      '用途：一次对比多个 sheet，验证跨 sheet 编排与「只在一侧存在」的边界。',
      '',
      '文件里各有 4 个 sheet：',
      '  共有：原料、成品',
      '  只在【旧】里有：已停用    → 应整表记为删除',
      '  只在【新】里有：新增品种  → 应整表记为新增',
      '',
      '期望结果：',
      '  原料：改 1（R2 黄芪 200→220）、删 1（R3 党参没了）、增 1（R4 甘草）',
      '  成品：无差异（切到该 sheet 应显示「没有差异」）',
      '  已停用：整表 2 行删除',
      '  新增品种：整表 1 行新增',
      '',
      '观察点：',
      '  · 顶部 sheet 切换条会把 4 个 sheet 都列出来，无差异的带 ✓ 标记',
      '  · 导出的 Excel 应包含上述所有分表'
    ]);
  });
}

/** 04 表头以上内容 */
function case04() {
  var dir = mkdirp(path.join(OUT, '04-表头以上内容'));
  // 真实报表常见：第1行大标题、第2行副标题/单位说明，第3行才是列名
  var ABOVE = [
    ['2024 年第二季度 提取物车间 生产数据汇总表'],
    ['编制单位：质量管理部', '', '单位：kg', '', '数据截止：2024-06-30']
  ];
  var HDR = [['批号', '品名', '投料量', '产出量', '收率(%)']];
  var OLD = [
    ['E001', '当归', 1000, 920, 92.0],
    ['E002', '黄芪', 1500, 1380, 92.0],
    ['E003', '党参', 800, 736, 92.0]
  ];
  var NEW = [
    ['E001', '当归', 1000, 910, 91.0],
    ['E002', '黄芪', 1500, 1380, 92.0],
    ['E003', '党参', 800, 700, 87.5]
  ];
  var widths = [10, 12, 12, 12, 11];
  var freeze = { state: 'frozen', ySplit: 3 };
  return Promise.all([
    writeBook(path.join(dir, '旧.xlsx'), [{ name: '生产数据', above: ABOVE, headers: HDR, rows: OLD, widths: widths, freeze: freeze, merges: ['A1:E1', 'A2:B2', 'C2:D2'] }]),
    writeBook(path.join(dir, '新.xlsx'), [{ name: '生产数据', above: ABOVE, headers: HDR, rows: NEW, widths: widths, freeze: freeze, merges: ['A1:E1', 'A2:B2', 'C2:D2'] }])
  ]).then(function () {
    writeNote(dir, [
      '【04 表头以上内容】',
      '',
      '用途：验证「表头行以上的内容要保留」这条需求。',
      '文件结构：',
      '  第1行：大标题「2024 年第二季度 提取物车间 生产数据汇总表」（A1:E1 合并）',
      '  第2行：编制单位 / 单位 / 数据截止日期（A2:B2、C2:D2 合并）',
      '  第3行：真正的列名',
      '  第4行起：数据',
      '',
      '配置要点：表头行填【起始 3】【结束 3】。',
      '',
      '期望结果：',
      '  修改 2 行：E001（产出量、收率 都变）、E003（产出量 736→700，收率 92→87.5）',
      '  新增/删除 0 行',
      '',
      '观察点（这是本套的重点）：',
      '  · 导出 Excel 里应有「生产数据_新_源表头以上」和「生产数据_旧_源表头以上」两张表',
      '  · 打开该表应能看到大标题和编制单位那两行，而不是只有数据',
      '  · 数据分表的行号列里，第一条数据应是「新 4 行」而不是「新 1 行」（行号按源表绝对行号）'
    ]);
  });
}

/** 05 格式还原 */
function case05() {
  var dir = mkdirp(path.join(OUT, '05-格式还原'));
  var HEADERS = [['编号', '物料名称', '规格', '库存', '状态']];
  var OLD = [
    ['M001', '当归', '统货', 520, '正常'],
    ['M002', '黄芪', '选货', 310, '正常'],
    ['M003', '党参', '统货', 180, '待检'],
    ['M004', '甘草', '统货', 640, '正常']
  ];
  var NEW = [
    ['M001', '当归', '统货', 480, '正常'],
    ['M002', '黄芪', '选货', 310, '正常'],
    ['M003', '党参', '统货', 180, '停用'],
    ['M004', '甘草', '统货', 700, '正常']
  ];
  var widths = [10, 16, 10, 10, 10];
  return Promise.all([
    writeBook(path.join(dir, '旧.xlsx'), [{
      name: '物料台账', headers: HEADERS, rows: OLD, widths: widths, zebra: true,
      freeze: { state: 'frozen', xSplit: 2, ySplit: 1 }
    }]),
    writeBook(path.join(dir, '新.xlsx'), [{
      name: '物料台账', headers: HEADERS, rows: NEW, widths: widths, zebra: true,
      freeze: { state: 'frozen', xSplit: 2, ySplit: 1 }
    }])
  ]).then(function () {
    writeNote(dir, [
      '【05 格式还原】',
      '',
      '用途：验证导出报告的格式还原能力。源文件带了：',
      '  · 自定义列宽 10/16/10/10/10（第 2 列明显更宽）',
      '  · 表头：宋体 10pt 加粗 + 淡蓝底 + 全边框 + 居中',
      '  · 数据行：斑马纹（隔行浅灰底）+ 全边框',
      '  · 冻结窗格：冻结前 1 行 + 前 2 列',
      '',
      '期望结果：',
      '  修改 3 行：M001（库存 520→480）、M003（状态 待检→停用）、M004（库存 640→700）',
      '  新增/删除 0 行',
      '',
      '观察点（重点看格式）：',
      '  · 导出 Excel 的「物料台账_修改」表：列宽应与源文件一致（第 2 列明显宽）',
      '  · 表头应保留淡蓝底 + 加粗 + 边框',
      '  · 冻结窗格应保留（打开后滚动时表头不跑）',
      '  · 「修改」表里变化列会成对显示「新值 | 旧_值」并用同一浅色底标注'
    ]);
  });
}

/** 06 宽松比较 */
function case06() {
  var dir = mkdirp(path.join(OUT, '06-宽松比较'));
  var HEADERS = [['批号', '生产日期', '数量', '比例']];
  // 旧文件：日期写成带时间的真实日期类型；数量是整数；比例带浮点尾差
  var OLD = [
    ['C001', new Date(Date.UTC(2024, 4, 1)), 100, 98.5],
    ['C002', new Date(Date.UTC(2024, 4, 2)), 200, 0.1 + 0.2],   // 0.30000000000000004
    ['C003', new Date(Date.UTC(2024, 4, 3)), 0, 50.0]
  ];
  var NEW = [
    ['C001', '2024-05-01', '100', '98.5'],     // 全部是字符串，但语义相同 → 不应报差异
    ['C002', '2024-05-02', '200.0', '0.3'],    // 数量和比例都是字符串/近似值 → 不应报差异
    ['C003', '2024-05-03', '0.0', '50']        // 0 / 0.0 / '0.0' 应等价
  ];
  var widths = [10, 14, 10, 10];
  return Promise.all([
    writeBook(path.join(dir, '旧.xlsx'), [{ name: '数据', headers: HEADERS, rows: OLD, widths: widths }]),
    writeBook(path.join(dir, '新.xlsx'), [{ name: '数据', headers: HEADERS, rows: NEW, widths: widths }])
  ]).then(function () {
    writeNote(dir, [
      '【06 宽松比较】',
      '',
      '用途：验证「不误报」——同一个值用不同类型/不同写法存，不应算作差异。',
      '',
      '三行数据在字面上都不同，但语义完全一致：',
      '  C001  日期：真实日期类型  vs  字符串 "2024-05-01"   → 应判等',
      '        数量：数字 100       vs  字符串 "100"          → 应判等',
      '  C002  数量：数字 200       vs  字符串 "200.0"        → 应判等',
      '        比例：0.1+0.2(浮点尾差) vs "0.3"               → 应判等',
      '  C003  数量：数字 0         vs  字符串 "0.0"          → 应判等',
      '        比例：数字 50.0      vs  字符串 "50"           → 应判等',
      '',
      '期望结果：新增 0、修改 0、删除 0 —— 全部判等。',
      '',
      '如果不做宽松比较，这里会报出 3 行「全列都变了」的假差异，',
      '这正是 aibg 那边的 values_equal 要处理的问题。',
      '',
      '反向验证（可选）：把某一格真的改掉（比如 C001 日期改成 2024-05-09），',
      '再对比一次，应该只报那一个单元格。'
    ]);
  });
}

/** 07 无键列哈希 */
function case07() {
  var dir = mkdirp(path.join(OUT, '07-无键列哈希'));
  var HEADERS = [['项目', '说明', '备注']];
  var OLD = [
    ['A', '第一条说明', '无'],
    ['B', '第二条说明', '无'],
    ['C', '第三条说明', '有']
  ];
  var NEW = [
    ['A', '第一条说明', '无'],
    ['B', '第二条说明（已修正）', '无'],   // 整行变了
    ['D', '第四条说明', '无']             // 新增
  ];
  var widths = [10, 24, 10];
  return Promise.all([
    writeBook(path.join(dir, '旧.xlsx'), [{ name: '清单', headers: HEADERS, rows: OLD, widths: widths }]),
    writeBook(path.join(dir, '新.xlsx'), [{ name: '清单', headers: HEADERS, rows: NEW, widths: widths }])
  ]).then(function () {
    writeNote(dir, [
      '【07 无键列哈希】',
      '',
      '用途：验证退化模式。这个表故意不使用任何「批号/ID/编号」这类列名，',
      '自动识别找不到键列 → 退化为整行哈希比对。',
      '',
      '期望结果：',
      '  新增 2 行：B（内容变了，哈希对不上 → 算新增）、D（真的新增）',
      '  删除 2 行：B（旧的 B 对不上 → 算删除）、C（真的删了）',
      '  修改 0 行 —— 这是哈希模式的固有局限：没有键就无法知道「哪一行对应哪一行」',
      '',
      '所以 B 那一行会同时出现在「新增」和「删除」里，看起来像改了两处。',
      '',
      '观察点：',
      '  · 结果区顶部会提示「无可用键列，退化为整行哈希比对（只能看出整行新增/删除，判不出改了哪一列）」',
      '  · 这是有意的取舍：没有键就无法知道「哪一行对应哪一行」',
      '',
      '对比实验：把「项目」列勾选为键列再跑一次，B 那行就会正确显示为「修改」'
    ]);
  });
}

/** 08 真实业务形态（宽表） */
function case08() {
  var dir = mkdirp(path.join(OUT, '08-真实业务形态'));
  // 仿厂区报表：两行表头 + 109 列 + 上千行
  var N_COL = 109;
  var ROWS = 800;

  function buildRows(seed, mutate) {
    var out = [];
    for (var r = 0; r < ROWS; r++) {
      var row = [
        (r % 2 === 0) ? '罐提' : '逆流',
        (r % 3 === 0) ? '国标' : '省标',
        new Date(Date.UTC(2024, 0, 1) + r * 86400000),
        '药材' + r,
        'AL24' + String(r).padStart(5, '0') + (mutate && r % 50 === 0 ? 'X' : '')
      ];
      for (var c = 5; c < N_COL; c++) {
        // 数值只由行号与列号决定，**不掺 seed** —— 否则新旧文件几乎每格都不同，
        // 会造出「改 784 行」这种失真结果，看不出差异定位能力。
        var v = ((r * 7 + c) % 1000) / 10;
        if (mutate && r % 97 === 0 && c === 10) v = v + 1;   // 少量行做修改
        row.push(v);
      }
      out.push(row);
    }
    return out;
  }

  var HDR1 = [];
  for (var i = 0; i < N_COL; i++) HDR1.push(i < 13 ? '公共列' : (i === 13 ? '罐提' : '公共列'));
  var HDR2 = ['提取方式', '执行标准', '生产日期', '新标准品名', '提取物批号'];
  for (var c2 = 5; c2 < N_COL; c2++) HDR2.push('指标' + c2);

  var widths = [];
  for (var w = 0; w < N_COL; w++) widths.push(w === 3 ? 14 : (w === 4 ? 16 : 9));

  return Promise.all([
    writeBook(path.join(dir, '旧.xlsx'), [{
      name: '生产数据收集表', headers: [HDR1, HDR2], rows: buildRows(0, false),
      widths: widths, freeze: { state: 'frozen', xSplit: 6, ySplit: 2 }
    }]),
    writeBook(path.join(dir, '新.xlsx'), [{
      name: '生产数据收集表', headers: [HDR1, HDR2], rows: buildRows(0, true),
      widths: widths, freeze: { state: 'frozen', xSplit: 6, ySplit: 2 }
    }])
  ]).then(function () {
    writeNote(dir, [
      '【08 真实业务形态】',
      '',
      '用途：贴近你厂区真实报表的形态，验证宽表 + 大量行。',
      '规模：每个文件 1 个 sheet、2 行表头、109 列、800 行数据。',
      '',
      '配置要点：表头行填【起始 1】【结束 2】。',
      '',
      '期望结果：',
      '  新增 16 行（每 50 行一行的批号尾号带 X，共 800/50=16 行）',
      '  修改 8 行（每 97 行一行的第 10 个指标列被 +1；800 行里 r=0,97,...,776 共 8 行）',
      '  删除 16 行',
      '',
      '观察点（性能与体验）：',
      '  · 读取应在 1~2 秒内完成（真实 2000 行大表实测约 0.6 秒）',
      '  · 主区域3 的表格可以横向滚动看 109 列，纵向滚动不卡（虚拟滚动）',
      '  · 列宽应保留（第 4、5 列更宽）',
      '  · 导出报告后，打开应能直接看到变化列成对显示',
      '',
      '这个规模是用来压测的，实际你日常文件通常 5000 行以内，也没问题。'
    ]);
  });
}

// ---------- 跑 ----------

var CASES = [
  ['01 单 sheet 基础', case01],
  ['02 多行表头', case02],
  ['03 多 sheet', case03],
  ['04 表头以上内容', case04],
  ['05 格式还原', case05],
  ['06 宽松比较', case06],
  ['07 无键列哈希', case07],
  ['08 真实业务形态', case08]
];

mkdirp(OUT);
console.log('生成 Excel 测试模板 → ' + OUT + '\n');

var chain = Promise.resolve();
CASES.forEach(function (c) {
  chain = chain.then(function () {
    var t = Date.now();
    return c[1]().then(function () {
      console.log('  ✓ ' + c[0] + '  (' + (Date.now() - t) + 'ms)');
    });
  });
});

chain.then(function () {
  // 顶层说明
  writeNote(OUT, [
    'Excel 对比测试模板',
    '==================',
    '',
    '每个子目录里都是【旧.xlsx】+【新.xlsx】一对，在 compare-text 里左右各选一个即可。',
    '每个目录里还有一份「说明.txt」，写了这份模板要验证什么、期望结果是什么。',
    '',
    '使用步骤：',
    '  1. 侧边栏「对比源」选到 demo/xlsx 这个目录（或某个子目录）',
    '  2. 顶部「子文件夹」选具体一套，再选左右两个文件',
    '  3. 出现「表格对比配置」按钮后点开，按说明填表头行/键列',
    '  4. 开始对比 → 看结果区三视图 + 主区域3 表格',
    '  5. 点「导出 Excel 报告」验证格式还原',
    '',
    '目录一览：',
    '  01-单sheet-基础      增删改齐备，最直观的入门样例',
    '  02-多行表头          两行表头，验证「父 / 子」列名拼接',
    '  03-多sheet           4 个 sheet，含只在一侧存在的 sheet',
    '  04-表头以上内容      标题栏/编制单位在表头上方，验证保留',
    '  05-格式还原          列宽/填充/边框/斑马纹/冻结/合并，验证报告格式',
    '  06-宽松比较          日期跨类型、0 vs 0.0、浮点尾差，验证不误报',
    '  07-无键列哈希        没有 ID 列，验证退化模式与提示文案',
    '  08-真实业务形态      109 列 × 800 行宽表，压测性能与横向滚动',
    '',
    '重新生成：node tools/make-xlsx-demo.js'
  ]);
  console.log('\n全部生成完毕 → ' + OUT);
  console.log('（顶层有一份总说明，每个子目录各有一份 说明.txt）');
}).catch(function (e) {
  console.error('生成失败：', e && e.stack);
  process.exit(1);
});
