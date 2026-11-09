'use strict';

/**
 * export_plan_registry — 导出计划注册表(2026-07-16 资料库P0,用户拍板"配置台/资料库 1:1 同源")。
 *
 * 从 config_console_routes 抽出的**唯一**计划清单实现:配置台管理页和资料库交付页
 * 都从这里拿"有哪些计划、叫什么、规则是什么"——两处引用同一份,不是复制。
 *
 * BUILTIN_PLANS:老 planner/导出服务承载的内置出口(防第二真相源,规则说明见
 * builtin_export_plan_specs.js);DSL/Excel 计划在 config_entries(kind='export_plan')。
 * 注意:name 是 config_entries 的键,**改名=配置分裂**,永远别动;白话展示名在前端做。
 */

const { getBuiltinPlanSpec } = require('./builtin_export_plan_specs');

const BUILTIN_PLANS = Object.freeze([
  { name: '内置·多模式四规则', payload: { planLabel: '内置·多模式四规则(济州道辉/现代三池/S活动双份/百货上家链/未归类)', builtin: 'mode_delivery' } },
  { name: '内置·乐天百货门店双图', payload: { planLabel: '内置·乐天百货门店双图', builtin: 'lotte_dept' } },
  // 2026-07-16 收编三个老出口(执行仍走各自老端点,这里只登记"存在+规则")
  { name: '内置·现代三池交付包', payload: { planLabel: '内置·现代三池交付包(护照/机票/小票按票号)', builtin: 'hyundai_delivery' } },
  { name: '内置·客户文件夹', payload: { planLabel: '内置·客户文件夹(每客户一夹装全部原图)', builtin: 'customer_folders' } },
  { name: '内置·客户数据Excel', payload: { planLabel: '内置·客户数据Excel(sheet1汇总+每模式一sheet+需重拍)', builtin: 'library_excel' } },
]);

/** 计划总列表:内置(可被 db 覆盖 label 等)在前,纯 db 计划(DSL/Excel)在后。 */
function planRowsForList(modeConfigRepository) {
  const configured = new Map(modeConfigRepository.getAllActive('export_plan').map((row) => [row.name, row]));
  const rows = [];
  for (const builtin of BUILTIN_PLANS) {
    const config = configured.get(builtin.name) || null;
    configured.delete(builtin.name);
    rows.push({
      name: builtin.name,
      label: (config && config.payload && config.payload.planLabel) || builtin.payload.planLabel,
      kindType: 'builtin',
      builtin: builtin.payload.builtin,
      rulesSpec: getBuiltinPlanSpec(builtin.payload.builtin), // 内置黑盒→只读规则明细(配置台/资料库共用)
      source: config ? 'db' : 'factory',
      config: config ? { version: config.version, payload: config.payload, createdAt: config.createdAt, createdBy: config.createdBy, note: config.note } : null,
      factory: builtin.payload,
    });
  }
  for (const [name, config] of configured) {
    rows.push({
      name,
      label: (config.payload && config.payload.planLabel) || name,
      kindType: config.payload && config.payload.builtin ? 'builtin' : 'dsl',
      builtin: (config.payload && config.payload.builtin) || null,
      source: 'db',
      config: { version: config.version, payload: config.payload, createdAt: config.createdAt, createdBy: config.createdBy, note: config.note },
      factory: null,
    });
  }
  return rows;
}

/** 已启用计划的 payload(执行/预检只认这个;草稿不算)。 */
function activePlanPayload(modeConfigRepository, name) {
  const row = modeConfigRepository.getActive('export_plan', name);
  if (row && row.payload) return row.payload;
  const builtin = BUILTIN_PLANS.find((b) => b.name === name);
  return builtin ? builtin.payload : null;
}

module.exports = { BUILTIN_PLANS, planRowsForList, activePlanPayload };
