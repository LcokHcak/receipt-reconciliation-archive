'use strict';

// 千问 VL 客户端 —— 一次 API 调用完成 版面切分 + 分类(护照/小票/其他) + 字段抽取。
// 阿里云百炼 OpenAI 兼容模式。prompt 已在 385 真值集上验证调优。
//
// 输出契约:{ documents: [{ type, bbox, confidence, fields }], usage, raw }
//   type ∈ passport | receipt | other
//   passport.fields: { passportNo, englishName, chineseName, mrz1, mrz2 }
//   receipt.fields:  { storeFamily, receiptNo, groupNo, purchaseDate, departureDate, passportNo }

const TYPE_ZH = Object.freeze({ passport: '护照', receipt: '小票', other: '其他' });

// prompt 版本:每次实质性改 prompt 必须 +1。sidecar 缓存带着这个戳,
// 版本不符的缓存自动作废重调——否则旧 prompt 的错误结果会在队列里潜伏,
// 任务轮到处理时原样回放(2026-07-03 事故:改 prompt 前建档写的 sidecar
// 随图拷进批次,识别时把示例泄漏的团号 71990 又放了出来)。
// v2 = 2026-07-03 去示例数字 + 新世界/现代规则 + 多票分框。
//      2026-07-20 识别错误矩阵 P1-P3 纯增量指引(票号定长/位置/陷阱、日期标签行/年份锚、
//      济州乐天 90G),不升版(d76bf51 先例:增量指引不作废存量缓存)。
const QWEN_PROMPT_VERSION = 2;

function buildLayoutPrompt(now = new Date()) {
  const nowYear = now.getFullYear();
  return [
    '你是免税购物单据的版面分析与识别器。一张照片里可能有多个独立文档(护照、购物小票,或无关的"其他",如包装、航班/离境截图、**登机牌/机票票根**(印有航班号/GATE/SEAT/BOARDING TIME/ZONE 的窄条卡片,不是购物小票)、手写纸条)。',
    '请找出图中每一个独立文档,对每个返回:',
    '- type: passport(护照) | receipt(小票) | other(其他)',
    '- bbox: [x1,y1,x2,y2] 归一化坐标,取值 0~1,相对整张图左上角(0,0)到右下角(1,1)。务必完整框住该文档的全部内容(含上下左右所有边缘),宁可多带一点背景,也绝不要切掉单据任何一边;小票多为细长竖条,尤其注意把整条小票的左右两侧都完整框进来,不要只框中间一条。',
    '- confidence: 0~1,看不清/不确定就给低分',
    '- fields: 按类型抽以下字段(缺失留空字符串):',
    '  护照 → {passportNo:护照号, englishName:英文姓名(机读区拼音), chineseName:中文姓名, mrz1:机读区第一行, mrz2:机读区第二行}',
    '  ★ 护照号:中国电子护照号通常是 "E + 一个字母 + 7位数字"(如 EQ1035708、EK5372586、EA7871410),开头两位是字母(第2位常见 A-Q),不要把第2位字母看成数字0。务必以机读区 MRZ 第2行开头那9位为准、和证件上印的号交叉核对。',
    '  小票 → {storeFamily:店名。先分免税店还是百货。百货判定线索(任一命中即百货):①票面任何位置(含顶部/中部/页脚小字)出现 백화점/百货/DEPARTMENT STORE 字样;②小票顶部是品牌专柜名(LOUIS VUITTON/DIOR/CHANEL/VAN CLEEF & ARPELS/TIFFANY 等奢侈品牌 logo)**且票面找不到任何免税店名**(THE SHILLA/LOTTE DUTY FREE/SHINSEGAE/HYUNDAI/신라/면세점 都没有)——免税店小票顶部永远是免税店统一抬头,品牌只出现在商品行;两个条件都满足才按百货;③同一张照片里有 Global Blue(蓝色圆标)退税单——免税店购物没有 Global Blue 单;④购买日期行印有 "거래번호" 标签(百货 POS 特有;免税店小票用 BILL NO/NO./Group 标签,没有 거래번호)。都不命中才是免税店。',
    '    特别注意:抬头是 SHINSEGAE/신세계 或 HYUNDAI/현대,但票面第二行是 品牌名+코리아(如 루이비통코리아)+본점/점,购买行有 "거래번호",且找不到 BILL NO/GT:/단체 → 这是百货小票,填 "新世界百货"/"现代百货",不要填 SHINSEGAE/HYUNDAI。',
    '    反向陷阱:现代免税店的英文名就叫 HYUNDAI DEPARTMENT STORE(配 DUTY FREE 徽标)——票面出现 DEPARTMENT STORE 字样但同时有 DUTY FREE/DF Co./BILL NO/离境航班行(Departure/Flight)/美元计价 任一 → 是免税店 HYUNDAI,绝不按百货。',
    '    免税店只填 "THE SHILLA"/"LOTTE"/"SHILLA IPARK"/"SHINSEGAE"/"HYUNDAI" 之一(顶部 THE SHILLA→THE SHILLA(济州/首尔新罗都属此),LOTTE→LOTTE,SHINSEGAE(신세계)→SHINSEGAE,HYUNDAI(현대)→HYUNDAI,신라아이파크/SHILLA I\'PARK→SHILLA IPARK);不要用中下部公司法人名(如 "HDC...LTD")判断。',
    '    百货填 "乐天百货"(롯데백화점)/"新世界百货"(신세계백화점)/"现代百货"(현대백화점)之一。百货小票没有团号、常和护照拍在同一张图上;整张照片当作一个 document 返回,不要把百货小票和同框的护照拆成两个框。',
    '    百货额外字段:{amount:交易总金额(找 합계/합 계/총액/TOTAL 标签后的金额,只抄数字), branch:4位数字门店编号(乐天票=小票底部长条码数字串的**前4位**,原样照抄含前导零,不要翻译成门店名;读不到就留空,绝不能编造或抄本说明里出现的任何数字), brand:品牌(**一律写韩文**:루이비통/반클리프 아펠/티파니 三选一;票面印英文 LOUIS VUITTON 也写 루이비통、VAN CLEEF & ARPELS 写 반클리프 아펠、TIFFANY 写 티파니)}。',
    '    百货交易编号:百货小票的 receiptNo=购买日期行 "거래번호:" 标签后的编号,形如 4位数字-4位数字(带横线,原样照抄含横线)。**绝不要抄**:승인번호(支付授权号,常为8位纯数字,在票面中下部)、商品行的长串 SKU 编号、底部条码下的整串长数字、Global Blue 退税单上的 DOC ID。找不到 "거래번호" 标签就留空。',
    '  小票其余字段:{receiptNo:小票号, groupNo:团号, purchaseDate:购买日期YYYY-MM-DD, departureDate:出境/离境日期YYYY-MM-DD, englishName:小票上印的客人英文名(常标 "Name",可能部分打码,无则留空), passportNo:小票上印的护照号(常标 "Passport No",E+字母+7位数字,无则留空)}',
    '  ★ 日期年份要逐位仔细读(印刷小、易把个别数字认错):购买日期与出境日期的年份通常相同或相邻,读出相差多年的年份时请重看票面。',
    '  ★ 购买日期只认小票上部的标签行:LOTTE=SaleDT 行、SHINSEGAE=DAY/TIME 行、HYUNDAI=Sale Date 行、新罗系=SALE DATE 行;绝不要拿票面下部支付区的 DATE TIME/APPROVAL/BAR CODE/OrderNumber 行里的数字凑日期(新罗票实测病例:从底部支付块抄出与票面完全无关的日期)。',
    `  ★ 年份锚(当前年份 ${nowYear}):免税店小票都是近期购物,购买/出境年份应为当前年份或其前一年;读出更早或更晚的年份(高频错型:年份第 3、4 位被看错,如 26 误看成 20/22/23/25/28)几乎都是误读——回到票面把年份逐位重读一遍再定;重读后票面确实印着旧年份才照实抄,绝不因本规则改写票面真实内容。`,
    '  ★ 小票号 receiptNo:必须抄小票上印的完整编号,含全部横线分段和字母,一个分段都不能丢——',
    '    · SHINSEGAE:标签 "BILL NO",形如 数字2位-数字6位-数字3位-数字5位(四段带杠),四段全部抄下,绝不能只抄最后一段;',
    '    · LOTTE:通常 14 位纯数字,个别票号含英文字母(字母夹在数字中),含字母就原样带字母抄;',
    '    · THE SHILLA/SHILLA IPARK:13 位纯数字,常标 "NO."并带横线分组,横线可保留;',
    '    · HYUNDAI:带横线整串完整抄;与 SHINSEGAE 同形——标签 "Bill No",数字2位-数字6位-数字3位-数字5位 四段带杠(去杠共 16 位),四段一段都不能丢。',
    '  ★ 票号位置:免税店票号一律印在小票上部(店标/地址下方的第一块信息区)——LOTTE 是 SaleDT 行上方加大加粗的一行,SHINSEGAE 在 DAY/TIME 行下的 BILL NO 行,HYUNDAI 在 Corner 行下的 Bill No 行,新罗系在 NO. 标签行;多数票顶部条形码正下方还印着同一号码的无杠连串,与标签行读出的号不一致时,以更清晰的一处为准并把另一处重读一遍。',
    '  ★ 票号定长自检(抄完必对一遍,对不上=某位看错,回票面重读):SHINSEGAE/HYUNDAI 去杠后应恰 16 位,且第 3-8 位=购买日期 YYMMDD(例如票面 DAY/TIME 是 2026 年 7 月 3 日,则第 3-8 位应是 260703);LOTTE 去杠后应恰 14 位,第 1 位是 9(读出 3/5/8 开头时重看是不是 9),第 7-8 位=购买年份后两位;新罗系(THE SHILLA/SHILLA IPARK)应恰 13 位。',
    '  ★ 济州乐天(票面地址含 Jeju/제주、电话 064 开头):票号第 3 位多数是字母 G(9、0 之后接 G),与数字 6 极易混淆——必须放大逐笔看清(G 有横向短杠和开口,6 是闭合圆肚);少数济州票第 3 位确实是数字。票面印什么抄什么,以放大后的笔画为准,绝不要凭"济州=G"的印象把真 6 写成 G,也不要把 G 看成 6。',
    '  ★ 票号陷阱:票面中下部支付区的长数字串绝不是票号——APPROVAL/APROVAL NO/승인번호/OrderNumber(常以 4200 开头、12~28 位、中间嵌着日期)、WECHAT/Alipay 付款单号、BAR CODE 行、Exchange Rate 行都不要抄;CORNER/柜台行(常含楼层字母如 9F)和 Group/G#/단체 行也不是票号。',
    '  ★ 票号以 0 开头时,所有前导 0 必须一并抄上(去掉前导 0 就少一位);同一照片多张小票并排时,每张小票的票号/日期只能抄它自己纸面上的,绝不能抄成旁边那张的(并排小票的票号常只差最后一两位)。',
    '  ★ 团号 groupNo:旅游团号,不同免税店位置不同——新罗/爱宝客常在小票上部 CORNER 行右侧、标签 "G :" 后约 5 位数字;乐天常标 "Group :" 后约 8 位数字;SHINSEGAE 在 BILL NO 同一行右侧方括号内、标签 "GT:" 后约 5 位数字;标签还可能是 GROUP / 团号 / 단체。请从图中定位并抄出那个数字(可带原标签,会再清洗);不要拿柜台号、商品码、小票号顶替;机场票团号栏印"无"就填"无"。图中找不到团号就留空字符串——绝不允许编造或填写本说明文字里出现过的任何数字。',
    '  ★ 票面常有店员用笔圈画/划线标注:被圈住的**印刷**内容(团号、离境日期、小票号等)往往正是要抄的关键字段,照常仔细读,不要因为有笔迹就跳过或漏读;但手写添加的数字本身不要抄进任何字段。',
    '  其他 → {}',
    '- fieldBoxes: 每个抽到的字段在图上的位置,和 bbox 同样是 [x1,y1,x2,y2] 归一化坐标、相对**整张图**。三条硬要求:①每个框必须**落在该 document 自己的 bbox 之内**;②必须**紧贴那串值本身**(不含标签文字、不含整行);③**定位不确定就不要给这个键** —— 宁可不给,也绝不要给一个大概位置。特别注意:不要把几个字段的框排成左缘对齐、纵向等距的一列 —— 那说明你在均匀铺放而不是在定位,是错的。小票可给 receiptNo/groupNo/purchaseDate/departureDate;护照可给 passportNo/englishName/chineseName。',
    '只输出 JSON,格式:{"documents":[{"type":"passport","bbox":[0,0,0.5,1],"confidence":0.9,"fields":{...},"fieldBoxes":{"passportNo":[0.1,0.7,0.5,0.76]}}]}。',
    '不要解释。整张图只有一个文档也返回含 1 元素的数组(bbox 可为 [0,0,1,1])。图里没有任何单据则返回 {"documents":[]}。',
    '一张照片里多张小票并排/上下叠放时,每张小票必须是独立的 document(各自 bbox 各自 fields),绝不能把两张小票合并成一个框。',
    '护照和小票放在一起拍(相邻/部分压叠)时:护照的 bbox 只框护照本体,小票的 bbox 只框小票纸面,两个框不得互相包含对方的主体;同一本护照/同一张小票在一张照片里只输出一次,不要重复输出。',
    '再次强调:每个字段只能来自图中实际印刷/手写的内容,读不到就留空,绝不能拿本说明中的示例格式或数字充当答案。',
  ].join('\n');
}

// 百货专项补救 prompt(两段式第二段)版本:改实质内容必须 +1。
// 独立于 QWEN_PROMPT_VERSION(第一段版面 prompt)——补救只在信号命中时追加调用,
// 不影响存量 sidecar 有效性判定。
// v2 = 金标重放二轮:加 barcodeDigits(条码整串,代码里按日期锚确定性切 店码/交易号/金额)
//      + 现代免税店陷阱(英文名就含 HYUNDAI DEPARTMENT STORE,靠 DUTY FREE/BILL NO/航班行否决)。
// v3 = 三轮:GB 单优先级抬高(pos_008 病例:GB 单自带 KOREA TAX FREE FORM 字样反被免税店
//      否决清单咬中)+ 支持第二张小票放大裁片(字段以裁片为准)+ 品牌反默认(不确定留空)。
const DEPT_RESCUE_PROMPT_VERSION = 3;

// 两段式第二段:第一段版面分析发现百货信号(Global Blue 单/品牌当店名/거래번호 形态/
// 护照+小票同框)后,用这个聚焦 prompt 单独重问一次(高分辨率)。字段位置按 2026-07 金标真票解剖:
// 거래번호 印在购买日期行(4位-4位带杠)、底部条码=店码+日期+交易号+金额连写、승인번호是陷阱。
function buildDeptRescuePrompt() {
  return [
    '你是韩国百货公司(department store)购物凭证识别器。第一张图是完整照片,可能包含:品牌专柜小票(第一/二行是 品牌名+코리아,如 루이비통코리아/디올코리아,配 롯데/신세계/현대 门店名如 본점/애비뉴엘)、Global Blue 退税单(蓝色圆花标)、客人护照页;也可能其实是免税店小票。若还有第二张图,那是第一张里品牌小票的放大裁片——**小票上的字段(거래번호/합계金额/购买日期/条码数字/品牌抬头)一律以放大裁片为准**,整体判断(是否百货/归属/护照/退税单)看第一张。',
    '第一步判断这是不是百货购物凭证:',
    '- 最强信号:照片里有 Global Blue 退税单(蓝色圆花标,标题 KOREA TAX FREE FORM)→ 几乎必是百货(免税店购物绝不会有 Global Blue 单)。注意:GB 单自己印的 TAX FREE 字样**不算**免税店特征。',
    '- 百货特征:品牌专柜抬头 + 购买日期行有 "거래번호:" 标签 + 常与护照拍在同一张照片。',
    '- 免税店特征(仅看**购物小票本身**,命中任一就 isDept:false):小票印有 DUTY FREE/면세점/DF Co. 字样、BILL NO 标签、团号(Group/GT:/단체/G#)、离境航班行(Departure/Flight No)、美元计价($)、면세한도 字样。**特别注意:现代免税店的英文名就叫 HYUNDAI DEPARTMENT STORE(配 DUTY FREE 徽标)——看到 DEPARTMENT STORE 字样但同票有上述任一免税店特征,一律 isDept:false**。',
    '- 归属:看小票抬头门店名,或 Global Blue 单上的 retailer 行(含 LOTTE→乐天百货,SHINSEGAE→新世界百货,HYUNDAI→现代百货)。',
    '不是百货凭证就只输出 {"isDept":false}。',
    '是百货则输出:{"isDept":true,"store":"乐天百货/新世界百货/现代百货 三选一","receiptNo":"购买日期行 거래번호: 标签后的编号,4位数字-4位数字,原样带横线照抄","amount":"합계/합 계/Total Amount 后的交易总金额,只抄数字","purchaseDate":"구매/购买行日期,YYYY-MM-DD","barcodeDigits":"小票最底部条形码正下方印的整串连续数字,从第一位到最后一位一字不差照抄(通常20位以上,可能以0开头;条码被裁掉/看不清就留空,绝不猜)","brand":"品牌,按小票**抬头第一行**实际印的品牌写,一律写韩文:루이비통/반클리프 아펠/티파니 三选一(票面英文 LOUIS VUITTON→루이비통,VAN CLEEF & ARPELS→반클리프 아펠,TIFFANY→티파니);三个都可能出现,绝不默认某一个,抬头看不清就留空","englishName":"客人英文姓名:优先同框护照页机读区拼音;没有护照页就用 Global Blue 单 FULL NAME 行;都没有留空","passportNo":"护照号:优先同框护照页机读区第2行开头9位并与证件印刷号交叉核对;没有护照页就用 Global Blue 单 PASSPORT NO 行;都没有留空","confidence":0到1}。',
    'receiptNo 绝不要抄:승인번호(支付授权号,常为8位纯数字)、商品行长串 SKU 编号、Global Blue 单 DOC ID、日期。barcodeDigits 只抄条形码下方那一串,不要抄别处数字。',
    '所有字段读不到就留空字符串,绝不编造,绝不抄本说明中的示例格式。只输出 JSON,不要解释。',
  ].join('\n');
}

// P2 票号区放大二遍 prompt(2026-07-20 识别错误矩阵):锚点自检未过(或全量双读模式)
// 的小票,裁上部放大后聚焦重读一次票号。改实质内容必须 +1(潜伏回放同款风险;
// 该版本只进 modelMeta 留痕,不参与 sidecar 复用判定——二遍失败保一遍值+红标,
// 值仍在、人工已被引导,无需作废缓存)。
// v2 = 90% 冲刺二批:按店分文案(乐天/新世界现代 16 位/新罗系 13 位)。
const RECEIPT_NO_REPAIR_PROMPT_VERSION = 2;

// 各店"票号在哪、长什么样"——与版面 prompt 的定长自检同源(实测规格见 receipt_no_anchors)。
const REPAIR_SHAPE_BY_STORE = Object.freeze({
  LOTTE: [
    '这是一张乐天免税店(LOTTE DUTY FREE)小票的上部放大图。图中有一行加大加粗的票号(在 SaleDT 行上方、店标/地址下方),请只把这一行票号逐位抄出来。',
    '形态自检:去掉横线后共 14 位;票面常按 6位-2位-6位 分三段印,横线原样保留;第 1 位是 9(看着像 3/5/8 时再放大确认是不是 9);第 7-8 位(第二段)=购买年份后两位。',
    '济州店(地址含 Jeju/제주):票号第 3 位多数是字母 G(9、0 之后接 G),与数字 6 极易混淆——逐笔看清(G 有横向短杠和开口,6 是闭合圆肚);少数济州票第 3 位确实是数字。以票面实际笔画为准:印 G 抄 G,印 6 抄 6,两个方向都不要凭印象改。',
  ],
  SHINSEGAE: [
    '这是一张新世界免税店(SHINSEGAE DUTY FREE)小票的上部放大图。票号在 "BILL NO" 标签行(DAY/TIME 行下方),请只把这一行票号逐位抄出来。',
    '形态自检:数字2位-数字6位-数字3位-数字5位 四段带杠(去杠共 16 位),四段一段都不能丢,横线原样保留;第 2 段 6 位=票面 DAY/TIME 的购买日期 YYMMDD,抄完对一遍,对不上就回票面重读;首段以 0 开头时前导 0 必须抄上。',
    '同一行右侧方括号 [GT:…] 是团号,不属于票号,不要带进来。',
  ],
  HYUNDAI: [
    '这是一张现代免税店(HYUNDAI DUTY FREE)小票的上部放大图。票号在 "Bill No" 标签行(Corner 行下方),顶部条形码正下方还印着同一号码的 16 位连串,两处可互相核对。请只抄票号。',
    '形态自检:数字2位-数字6位-数字3位-数字5位 四段带杠(去杠共 16 位),横线原样保留;第 2 段 6 位=票面 Sale Date 的购买日期 YYMMDD,抄完对一遍;首段以 0 开头时前导 0 必须抄上。',
  ],
  'THE SHILLA': [
    '这是一张新罗免税店(THE SHILLA)小票的上部放大图。票号在 "NO." 标签行,顶部条形码正下方还印着同一号码的 13 位连串,两处可互相核对。请只抄票号。',
    '形态自检:常按 2位-3位-3位-4位-1位 分段带杠(去杠共 13 位),横线原样保留;第 3-4 位=购买年份后两位;首位以 0 开头时前导 0 必须抄上。',
  ],
  'SHILLA IPARK': [
    '这是一张新罗爱宝客(SHILLA IPARK)免税店小票的上部放大图。票号在 "NO." 标签行,顶部条形码正下方还印着同一号码的 13 位连串,两处可互相核对。请只抄票号。',
    '形态自检:常按 2位-3位-3位-4位-1位 分段带杠(去杠共 13 位),横线原样保留;第 3-4 位=购买年份后两位。',
  ],
});

function buildReceiptNoRepairPrompt(storeFamily) {
  const shape = REPAIR_SHAPE_BY_STORE[String(storeFamily || '').trim().toUpperCase()]
    || REPAIR_SHAPE_BY_STORE.LOTTE;
  return [
    ...shape,
    '绝不要抄:Group/GT/G# 行(团号)、CORNER/柜台行、APROVAL/APPROVAL/승인번호/WECHAT/Alipay 支付长号(常 4200 开头)、条形码行本身的黑条、日期行。',
    '只输出 JSON:{"receiptNo":"逐位照抄含横线","confidence":0到1}。看不清或找不到票号就输出 {"receiptNo":"","confidence":0}。绝不编造,绝不抄本说明里的任何数字。',
  ].join('\n');
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return {}; }
    }
    return {};
  }
}

function normalizeDoc(raw = {}) {
  const type = ['passport', 'receipt', 'other'].includes(raw.type) ? raw.type : 'other';
  let bbox = Array.isArray(raw.bbox) && raw.bbox.length === 4 ? raw.bbox.map(Number) : [0, 0, 1, 1];
  if (bbox.some((v) => v > 1.5)) {
    const maxv = Math.max(...bbox);
    const scale = maxv > 1000 ? maxv : 1000;
    bbox = bbox.map((v) => v / scale);
  }
  bbox = bbox.map((v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)));
  return {
    type,
    typeZh: TYPE_ZH[type],
    bbox,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    fields: raw.fields && typeof raw.fields === 'object' ? raw.fields : {},
    // 字段框(0729):每个字段在**整张图**里的位置。审核台据此画字段定位框。
    // 这里只做透传不做校验 —— 归一化/坐标换算/面积闸都在
    // lib/qwen_ocr/field_regions_from_qwen.js(纯函数,可单测)。
    fieldBoxes: raw.fieldBoxes && typeof raw.fieldBoxes === 'object' ? raw.fieldBoxes : null,
  };
}

// imageBase64Url: data:image/...;base64,xxxx
// fetchImpl 可注入(测试用 mock)
async function analyzeImage({
  imageBase64Url,
  imageBase64Urls = null, // 多图(百货补救:全景+小票放大裁片);给了就优先于单图参数
  apiKey,
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90000,
  systemPrompt = '', // 空=默认版面 prompt;百货补救第二段传 buildDeptRescuePrompt()
}) {
  const urls = Array.isArray(imageBase64Urls) && imageBase64Urls.length
    ? imageBase64Urls
    : [imageBase64Url];
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt || buildLayoutPrompt() },
      {
        role: 'user',
        content: [
          { type: 'text', text: '分析该图片的版面,找出所有文档,仅输出 JSON。' },
          ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`千问 HTTP ${res.status} ${detail.slice(0, 200)}`);
    err.status = res.status;
    err.detail = detail;
    // 限流时尊重 Retry-After(秒)→ 供退避用
    const ra = res.headers?.get?.('Retry-After');
    const secs = ra != null ? Number(ra) : NaN;
    if (Number.isFinite(secs) && secs >= 0) err.retryAfterMs = secs * 1000;
    // 内容审核拒绝(2026-07-21 2000金标实测:护照人脸/证件触发 DataInspectionFailed,占护照 ~0.25%):
    // 这类是确定性拒绝、非可重试,标出来让上层落 qwen_content_rejected(而非笼统 qwen_failed),
    // 审核台提示"图被平台判敏感请人工录",别当识别故障排查。
    if (/data_inspection_failed|DataInspection/i.test(detail)) err.contentRejected = true;
    // 模型不可用(403 无权限 / 404 模型不存在):供 QWEN_FALLBACK_MODEL 回退判定
    if (res.status === 403 || res.status === 404 || /model.*(not found|unavailable|denied)/i.test(detail)) {
      err.modelUnavailable = true;
    }
    throw err;
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || '{}';
  const parsed = parseJsonLoose(content);
  const documents = Array.isArray(parsed.documents) ? parsed.documents.map(normalizeDoc) : [];
  return {
    documents,
    usage: json?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    raw: content,
  };
}

module.exports = {
  analyzeImage, buildLayoutPrompt, buildDeptRescuePrompt, buildReceiptNoRepairPrompt,
  normalizeDoc, parseJsonLoose,
  QWEN_PROMPT_VERSION, DEPT_RESCUE_PROMPT_VERSION, RECEIPT_NO_REPAIR_PROMPT_VERSION, TYPE_ZH,
};
