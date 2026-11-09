const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require('playwright');

function parseArgs(argv) {
  const args = {
    help: false,
    baseUrl: 'http://127.0.0.1:3218',
    workspace: '',
    runId: new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14),
    durationMs: 20 * 60 * 1000,
    pollMs: 1200,
    outDir: '',
    readOnly: false,
    unsafeActions: false,
    allowErrors: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--base-url' && next) {
      args.baseUrl = next.replace(/\/+$/, '');
      index += 1;
    } else if (current === '--workspace' && next) {
      args.workspace = next;
      index += 1;
    } else if (current === '--run-id' && next) {
      args.runId = next;
      index += 1;
    } else if (current === '--duration-ms' && next) {
      args.durationMs = Math.max(5000, Number.parseInt(next, 10) || args.durationMs);
      index += 1;
    } else if (current === '--poll-ms' && next) {
      args.pollMs = Math.max(250, Number.parseInt(next, 10) || args.pollMs);
      index += 1;
    } else if (current === '--out-dir' && next) {
      args.outDir = path.resolve(next);
      index += 1;
    } else if (current === '--read-only') {
      args.readOnly = true;
    } else if (current === '--unsafe-actions') {
      args.unsafeActions = true;
    } else if (current === '--allow-errors') {
      args.allowErrors = true;
    } else if (current === '--help' || current === '-h') {
      args.help = true;
    }
  }
  if (!args.outDir) {
    args.outDir = path.resolve(__dirname, '..', 'agent_docs', 'e2e-runs', args.runId);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/run_ui_chaos_probe.js --duration-ms 60000 --workspace <workspace>
  node scripts/run_ui_chaos_probe.js --base-url http://127.0.0.1:3218 --duration-ms 120000 --read-only

Options:
  --base-url <url>       Workbench URL, default http://127.0.0.1:3218
  --workspace <name>     Prefer a customer workspace/batch matching this name
  --run-id <id>          Output folder id
  --duration-ms <ms>     Probe duration, minimum 5000, default 1200000
  --poll-ms <ms>         Delay between probes, minimum 250, default 1200
  --out-dir <path>       Output folder for logs and summary
  --read-only            Avoid write/delete actions
  --unsafe-actions       Allow destructive probes where supported
  --allow-errors         Keep exit code 0 even if console/API errors are found
`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createJsonlLogger(outDir) {
  ensureDir(outDir);
  const logPath = path.join(outDir, 'ui_chaos.jsonl');
  return {
    logPath,
    write(event, data = {}) {
      const entry = {
        at: new Date().toISOString(),
        event,
        ...data,
      };
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
      return entry;
    },
  };
}

function summarizeApiPayload(payload = {}) {
  const batches = Array.isArray(payload.batches) ? payload.batches : [];
  const workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
  const customers = Array.isArray(payload.customers) ? payload.customers : [];
  const summary = {};

  if (batches.length) {
    summary.batchCount = batches.length;
    summary.batchIds = batches.slice(0, 10).map((batch) => batch.id || '');
    summary.batchStates = batches.slice(0, 10).map((batch) => batch.machineState || '');
    summary.batchCounts = batches.slice(0, 5).map((batch) => batch.counts || {});
  }
  if (workspaces.length || payload.workspaceKey) {
    summary.workspaceCount = workspaces.length;
    summary.workspaces = workspaces.slice(0, 10);
    if (payload.workspaceKey) {
      summary.workspaceKey = payload.workspaceKey;
    }
  }
  if (customers.length) {
    summary.customerCount = customers.length;
    summary.imageCount = customers.reduce((sum, customer) => (
      sum + (Array.isArray(customer.images) ? customer.images.length : 0)
    ), 0);
  }
  if (payload.counts) {
    summary.counts = payload.counts;
  }
  if (payload.ok === false || payload.error) {
    summary.ok = payload.ok;
    summary.error = payload.error;
  }
  return summary;
}

async function requestJson(baseUrl, routePath, options = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = { raw: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || text || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function pickStressBatch(state, workspace) {
  const batches = Array.isArray(state.batches) ? state.batches : [];
  const matched = batches.find((batch) => workspace && String(batch.name || '').includes(workspace))
    || batches.find((batch) => workspace && String(batch.id || '').includes(workspace));
  if (workspace) {
    return matched || null;
  }
  return batches[0] || null;
}

function buildScenarioPlan(args = {}) {
  const workspaceNote = args.workspace ? `target workspace ${args.workspace}` : 'first available workspace';
  return [
    {
      id: 'page-mode-hop',
      label: 'Navigate overview/customer/review/export/settings pages',
      expectation: 'Main shell changes pages without blanking or console errors.',
      tags: ['page-hop', 'buttons'],
    },
    {
      id: 'workspace-modal-address-edit',
      label: 'Open new workspace modal and edit root/name fields',
      expectation: `Workspace address/name controls accept edits for ${workspaceNote}.`,
      tags: ['new-directory', 'new-directory-address', 'buttons'],
    },
    {
      id: 'workspace-switch-existing',
      label: 'Switch across existing customer workspaces',
      expectation: 'Customer list reloads and active workspace state remains coherent.',
      tags: ['cross-customer', 'workspace'],
    },
    {
      id: 'customer-detail-hop',
      label: 'Open customer detail, return, and open another customer',
      expectation: 'Customer detail and list transitions preserve current workspace.',
      tags: ['cross-customer', 'buttons'],
    },
    {
      id: 'customer-image-buttons',
      label: 'Exercise customer image preview/confirm/delete controls safely',
      expectation: 'Image review buttons are discoverable; safe preview clicks do not break the queue.',
      tags: ['buttons', 'customer-image-review'],
    },
    {
      id: 'batch-open-and-group-hop',
      label: 'Open batch and hop across review groups',
      expectation: 'Batch selection and group detail navigation work across task groups.',
      tags: ['cross-task', 'review'],
    },
    {
      id: 'review-field-edit',
      label: 'Modify review fields and notes',
      expectation: 'Doc type, passport/receipt fields, and note inputs accept manual edits.',
      tags: ['field-edit', 'manual-review'],
    },
    {
      id: 'review-action-buttons',
      label: 'Probe review footer and image toolbar buttons',
      expectation: 'Review action buttons expose disabled/enabled states and safe toolbar clicks succeed.',
      tags: ['buttons', 'manual-review'],
    },
    {
      id: 'cross-page-customer-task-hop',
      label: 'Cross page, customer, and task operation chain',
      expectation: 'Fast context switches do not leave stale customer/task state on screen.',
      tags: ['cross-page', 'cross-customer', 'cross-task'],
    },
  ];
}

async function safeEvaluate(page, logger, label, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (error) {
    logger.write('ui_step_error', { label, error: error.message });
    return null;
  }
}

async function clickIfPresent(page, selector) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node || node.disabled) return false;
    node.click();
    return true;
  }, selector);
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    if (await clickIfPresent(page, selector)) {
      return selector;
    }
  }
  return '';
}

async function selectTargetWorkspace(page, logger, args) {
  if (!args.workspace) return { targetWorkspace: '', selected: '', created: false };
  await clickIfPresent(page, '#customerLibraryTabBtn');
  await page.waitForTimeout(100);
  const selected = await safeEvaluate(page, logger, 'select-target-workspace', (workspace) => {
    const buttons = [...document.querySelectorAll('[data-customer-workspace]')]
      .filter((node) => node.tagName === 'BUTTON' && !node.disabled);
    const button = buttons.find((node) => node.dataset.customerWorkspace === workspace)
      || buttons.find((node) => String(node.dataset.customerWorkspace || '').includes(workspace));
    if (!button) return '';
    button.click();
    return button.dataset.customerWorkspace || '';
  }, args.workspace);
  await page.waitForTimeout(200);
  if (selected || args.readOnly) {
    return { targetWorkspace: args.workspace, selected: selected || '', created: false };
  }
  await fillIfPresent(page, '#customerWorkspaceInput', args.workspace);
  const created = await clickIfPresent(page, '#ensureCustomerWorkspaceBtn');
  await page.waitForTimeout(250);
  return { targetWorkspace: args.workspace, selected: args.workspace, created };
}

async function fillIfPresent(page, selector, value) {
  return page.evaluate(({ selector, value }) => {
    const node = document.querySelector(selector);
    if (!node || node.disabled) return false;
    node.focus();
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { selector, value });
}

async function collectUiSnapshot(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.querySelector('h1')?.textContent?.trim() || '',
    viewMode: document.querySelector('.app-shell')?.dataset.viewMode || '',
    consolePage: [...document.querySelectorAll('[data-console-page].active')]
      .map((node) => node.getAttribute('data-console-page'))
      .filter(Boolean),
    reviewFlow: document.querySelector('.app-shell')?.dataset.reviewFlowView || '',
    activeBatchId: document.querySelector('[data-batch-id].active')?.getAttribute('data-batch-id') || '',
    activeCustomerId: document.querySelector('[data-open-customer-detail].active')?.getAttribute('data-open-customer-detail') || '',
    openModal: Boolean(document.querySelector('.customer-modal-layer')),
    visibleButtons: [...document.querySelectorAll('button')]
      .filter((button) => button.offsetParent !== null)
      .slice(0, 30)
      .map((button) => ({
        id: button.id || '',
        text: button.textContent.trim().slice(0, 40),
        disabled: Boolean(button.disabled),
      })),
    toast: [...document.querySelectorAll('[aria-live], .toast, .workflow-notice')]
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .slice(-4),
  }));
}

async function getApiSnapshot(args, batch) {
  const state = await requestJson(args.baseUrl, '/api/state').catch((error) => ({ ok: false, error: error.message }));
  const workspace = args.workspace || state.workspaceKey || '';
  const customers = workspace
    ? await requestJson(
      args.baseUrl,
      `/api/customer-library/workspaces/${encodeURIComponent(workspace)}/customers`
    ).catch((error) => ({ ok: false, error: error.message }))
    : null;
  const batchPayload = batch?.id
    ? await requestJson(args.baseUrl, `/api/batches/${encodeURIComponent(batch.id)}`).catch((error) => ({ ok: false, error: error.message }))
    : null;
  return {
    state: summarizeApiPayload(state),
    customers: customers ? summarizeApiPayload(customers) : null,
    batch: batchPayload ? summarizeApiPayload(batchPayload) : null,
  };
}

async function runScenarioStep(page, logger, args, context, scenario, stepName, fn) {
  const startedAt = Date.now();
  logger.write('ui_step_started', {
    iteration: context.iteration,
    scenarioId: scenario.id,
    stepName,
  });
  try {
    const result = await fn();
    const snapshot = await collectUiSnapshot(page).catch((error) => ({ error: error.message }));
    const api = await getApiSnapshot(args, context.batch).catch((error) => ({ error: error.message }));
    logger.write('ui_step_completed', {
      iteration: context.iteration,
      scenarioId: scenario.id,
      stepName,
      durationMs: Date.now() - startedAt,
      result,
      snapshot,
      api,
    });
    return result;
  } catch (error) {
    const screenshotPath = path.join(
      args.outDir,
      `ui_chaos_failed_${String(context.iteration).padStart(4, '0')}_${scenario.id}_${stepName}.png`
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
    logger.write('ui_step_failed', {
      iteration: context.iteration,
      scenarioId: scenario.id,
      stepName,
      durationMs: Date.now() - startedAt,
      error: error.message,
      screenshotPath,
    });
    throw error;
  }
}

async function executeScenario(page, logger, args, context, scenario) {
  const scratchWorkspace = `chaos-${args.runId}-${String(context.iteration).padStart(4, '0')}`;
  if (scenario.id === 'page-mode-hop') {
    return runScenarioStep(page, logger, args, context, scenario, 'click-navigation-buttons', async () => {
      const clicked = [];
      for (const selector of ['#overviewModeBtn', '#customerLibraryTabBtn', '#reviewModeBtn', '#manageBatchesTabBtn', '#settingsTabBtn']) {
        if (await clickIfPresent(page, selector)) clicked.push(selector);
        await page.waitForTimeout(80);
      }
      return { clicked };
    });
  }

  if (scenario.id === 'workspace-modal-address-edit') {
    return runScenarioStep(page, logger, args, context, scenario, 'edit-workspace-modal', async () => {
      await clickIfPresent(page, '#customerLibraryTabBtn');
      await page.waitForTimeout(120);
      await clickIfPresent(page, '#openCustomerWorkspaceModalBtn');
      await page.waitForTimeout(120);
      const currentRoot = await safeEvaluate(page, logger, 'workspace-modal-root', () => (
        document.querySelector('#customerWorkspaceRootModalInput')?.value || ''
      ));
      const rootEdited = await fillIfPresent(page, '#customerWorkspaceRootModalInput', currentRoot || '');
      const nameEdited = await fillIfPresent(page, '#customerWorkspaceNameModalInput', scratchWorkspace);
      let created = false;
      if (!args.workspace && !args.readOnly && !context.createdWorkspace && currentRoot && rootEdited && nameEdited) {
        created = await clickIfPresent(page, '#createCustomerWorkspaceFromModalBtn');
        context.createdWorkspace = created ? scratchWorkspace : '';
        await page.waitForTimeout(350);
      }
      if (args.workspace) {
        await clickIfPresent(page, '#closeCustomerWorkspaceModalBtn');
        await selectTargetWorkspace(page, logger, args);
      } else {
        await clickIfPresent(page, '#closeCustomerWorkspaceModalBtn');
      }
      return { rootEdited, nameEdited, created, scratchWorkspace };
    });
  }

  if (scenario.id === 'workspace-switch-existing') {
    return runScenarioStep(page, logger, args, context, scenario, 'switch-workspace-buttons', async () => {
      await clickIfPresent(page, '#customerLibraryTabBtn');
      await page.waitForTimeout(100);
      if (args.workspace) {
        const target = await selectTargetWorkspace(page, logger, args);
        return { switched: target.selected, targetWorkspace: args.workspace };
      }
      const switched = await safeEvaluate(page, logger, 'workspace-switch', (iteration) => {
        const buttons = [...document.querySelectorAll('[data-customer-workspace]')]
          .filter((node) => node.tagName === 'BUTTON' && !node.disabled);
        if (!buttons.length) return '';
        const button = buttons[iteration % buttons.length];
        button.click();
        return button.dataset.customerWorkspace || '';
      }, context.iteration);
      await page.waitForTimeout(300);
      return { switched };
    });
  }

  if (scenario.id === 'customer-detail-hop') {
    return runScenarioStep(page, logger, args, context, scenario, 'open-two-customers', async () => {
      await clickIfPresent(page, '#customerLibraryTabBtn');
      await page.waitForTimeout(100);
      await selectTargetWorkspace(page, logger, args);
      const opened = await safeEvaluate(page, logger, 'open-customers', (iteration) => {
        const buttons = [...document.querySelectorAll('button[data-open-customer-detail]')]
          .filter((button) => !button.disabled);
        if (!buttons.length) return [];
        const first = buttons[iteration % buttons.length];
        first.click();
        return [first.dataset.openCustomerDetail || ''];
      }, context.iteration) || [];
      await page.waitForTimeout(180);
      await clickIfPresent(page, '[data-customer-flow-back="customers"]');
      await page.waitForTimeout(120);
      const second = await safeEvaluate(page, logger, 'open-second-customer', (iteration) => {
        const buttons = [...document.querySelectorAll('button[data-open-customer-detail]')]
          .filter((button) => !button.disabled);
        if (buttons.length < 2) return '';
        const button = buttons[(iteration + 1) % buttons.length];
        button.click();
        return button.dataset.openCustomerDetail || '';
      }, context.iteration);
      await page.waitForTimeout(160);
      return { opened: opened.concat(second || []).filter(Boolean) };
    });
  }

  if (scenario.id === 'customer-image-buttons') {
    return runScenarioStep(page, logger, args, context, scenario, 'probe-image-buttons', async () => {
      await clickIfPresent(page, '#customerLibraryTabBtn');
      await page.waitForTimeout(100);
      await selectTargetWorkspace(page, logger, args);
      await clickFirst(page, ['button[data-open-customer-detail]', '[data-open-customer-detail]']);
      await page.waitForTimeout(160);
      const previewClicked = await clickIfPresent(page, '[data-customer-image-preview-url]');
      const approveButtons = await safeEvaluate(page, logger, 'image-button-state', () => ({
        approveCount: document.querySelectorAll('[data-approve-current-customer-image]').length,
        deleteCount: document.querySelectorAll('[data-delete-customer-image-id]').length,
      }));
      await clickIfPresent(page, '[data-customer-flow-back="customers"]');
      return { previewClicked, approveButtons };
    });
  }

  if (scenario.id === 'batch-open-and-group-hop') {
    return runScenarioStep(page, logger, args, context, scenario, 'open-batch-and-groups', async () => {
      await clickIfPresent(page, '#reviewModeBtn');
      await page.waitForTimeout(100);
      let openedBatch = '';
      if (context.batch?.id) {
        openedBatch = await safeEvaluate(page, logger, 'open-batch', (batchId) => {
          const button = document.querySelector(`button[data-batch-id="${batchId}"]`);
          if (button && !button.disabled) {
            button.click();
            return batchId;
          }
          return '';
        }, context.batch.id);
      }
      await page.waitForTimeout(180);
      const openedGroups = await safeEvaluate(page, logger, 'open-groups', (iteration) => {
        const rows = [...document.querySelectorAll('.approval-task-row[data-review-group-key], button[data-review-group-key]')];
        const keys = rows.map((row) => row.dataset.reviewGroupKey).filter(Boolean);
        keys.slice(iteration % Math.max(1, keys.length), (iteration % Math.max(1, keys.length)) + 2)
          .forEach((key) => {
            const button = document.querySelector(`button[data-review-group-key="${key}"], .approval-task-row[data-review-group-key="${key}"]`);
            if (button && !button.disabled) button.click();
          });
        return keys.slice(0, 5);
      }, context.iteration);
      await page.waitForTimeout(180);
      return { openedBatch, openedGroups };
    });
  }

  if (scenario.id === 'review-field-edit') {
    return runScenarioStep(page, logger, args, context, scenario, 'edit-review-fields', async () => {
      await clickIfPresent(page, '#reviewModeBtn');
      await page.waitForTimeout(100);
      await clickFirst(page, ['.approval-task-row[data-review-group-key]', 'button[data-review-group-key]']);
      await page.waitForTimeout(180);
      if (args.readOnly) {
        const fields = await safeEvaluate(page, logger, 'review-field-readonly-state', () => (
          ['#docTypeSelect', '#passportInput', '#receiptNoInput', '#reviewNoteInput'].map((selector) => ({
            selector,
            present: Boolean(document.querySelector(selector)),
            disabled: Boolean(document.querySelector(selector)?.disabled),
          }))
        ));
        return { readOnly: true, fields };
      }
      const edited = {
        docType: await fillIfPresent(page, '#docTypeSelect', context.iteration % 2 ? 'passport' : 'receipt'),
        passportNo: await fillIfPresent(page, '#passportInput', `PCHAOS${context.iteration}`),
        receiptNo: await fillIfPresent(page, '#receiptNoInput', `RCHAOS${context.iteration}`),
        note: await fillIfPresent(page, '#reviewNoteInput', `ui-chaos-note-${context.iteration}`),
      };
      await page.waitForTimeout(300);
      return { edited };
    });
  }

  if (scenario.id === 'review-action-buttons') {
    return runScenarioStep(page, logger, args, context, scenario, 'probe-review-buttons', async () => {
      await clickIfPresent(page, '#reviewModeBtn');
      await page.waitForTimeout(100);
      const safeClicks = [];
      for (const selector of ['#zoomInImageBtn', '#zoomOutImageBtn', '#rotateLeftImageBtn', '#rotateRightImageBtn']) {
        if (await clickIfPresent(page, selector)) safeClicks.push(selector);
        await page.waitForTimeout(80);
      }
      const unsafeStates = await safeEvaluate(page, logger, 'unsafe-button-state', () => (
        ['#approveTaskBtn', '#rephotoTaskBtn', '#resetTaskBtn', '#deleteTaskBtn'].map((selector) => {
          const button = document.querySelector(selector);
          return {
            selector,
            present: Boolean(button),
            disabled: Boolean(button?.disabled),
            text: button?.textContent?.trim() || '',
          };
        })
      ));
      const unsafeClicked = [];
      if (args.unsafeActions) {
        for (const selector of ['#saveTaskBtn', '#approveTaskBtn', '#rephotoTaskBtn', '#resetTaskBtn']) {
          if (await clickIfPresent(page, selector)) unsafeClicked.push(selector);
          await page.waitForTimeout(120);
        }
      }
      return { safeClicks, unsafeStates, unsafeClicked };
    });
  }

  return runScenarioStep(page, logger, args, context, scenario, 'cross-context-chain', async () => {
    const clicked = [];
    for (const selector of ['#overviewModeBtn', '#customerLibraryTabBtn', 'button[data-open-customer-detail]', '[data-customer-flow-back="customers"]', '#reviewModeBtn', '.approval-task-row[data-review-group-key]']) {
      if (await clickIfPresent(page, selector)) clicked.push(selector);
      await page.waitForTimeout(100);
    }
    return { clicked };
  });
}

async function randomUiProbe(page, logger, args, context) {
  const state = await requestJson(args.baseUrl, '/api/state').catch((error) => {
    logger.write('api_state_error', { error: error.message });
    return null;
  });
  context.batch = state ? pickStressBatch(state, args.workspace) : null;

  if (context.iteration % 12 === 0) {
    await page.goto(`${args.baseUrl}/app/?chaos=${Date.now()}`, { waitUntil: 'networkidle' });
  }

  const scenario = context.plan[(context.iteration - 1) % context.plan.length];
  logger.write('ui_scenario_started', {
    iteration: context.iteration,
    scenarioId: scenario.id,
    label: scenario.label,
    expectation: scenario.expectation,
    tags: scenario.tags,
    apiState: summarizeApiPayload(state || {}),
  });
  await executeScenario(page, logger, args, context, scenario);

  const snapshot = await collectUiSnapshot(page).catch((error) => ({ error: error.message }));
  logger.write('ui_probe', {
    iteration: context.iteration,
    scenarioId: scenario.id,
    batchId: context.batch?.id || '',
    batchState: context.batch?.machineState || '',
    counts: context.batch?.counts || null,
    snapshot,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const logger = createJsonlLogger(args.outDir);
  const plan = buildScenarioPlan(args);
  fs.writeFileSync(path.join(args.outDir, 'ui_chaos_scenarios.json'), JSON.stringify(plan, null, 2), 'utf8');
  logger.write('ui_chaos_started', {
    runId: args.runId,
    workspace: args.workspace,
    durationMs: args.durationMs,
    pollMs: args.pollMs,
    unsafeActions: args.unsafeActions,
    readOnly: args.readOnly,
    scenarios: plan.map((scenario) => scenario.id),
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
  const errors = [];
  const apiErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
      logger.write('console_error', { message: message.text() });
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
    logger.write('page_error', { message: error.message });
  });
  page.on('response', async (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      const item = `${response.status()} ${response.request().method()} ${response.url()}`;
      apiErrors.push(item);
      logger.write('http_error', {
        item,
        status: response.status(),
        method: response.request().method(),
        url: response.url(),
      });
    }
  });

  const startedAt = Date.now();
  const context = {
    iteration: 0,
    plan,
    batch: null,
    createdWorkspace: '',
  };
  await page.goto(`${args.baseUrl}/app/`, { waitUntil: 'networkidle' });
  while (Date.now() - startedAt < args.durationMs) {
    context.iteration += 1;
    await randomUiProbe(page, logger, args, context).catch((error) => {
      logger.write('probe_error', { iteration: context.iteration, error: error.message });
    });
    await page.waitForTimeout(args.pollMs);
  }

  const health = await requestJson(args.baseUrl, '/api/health').catch((error) => ({ ok: false, error: error.message }));
  const summary = {
    runId: args.runId,
    workspace: args.workspace,
    iterations: context.iteration,
    scenarios: plan.map((scenario) => ({
      id: scenario.id,
      label: scenario.label,
      tags: scenario.tags,
    })),
    createdWorkspace: context.createdWorkspace,
    readOnly: args.readOnly,
    allowErrors: args.allowErrors,
    consoleErrorCount: errors.length,
    consoleErrors: errors.slice(0, 50),
    apiErrorCount: apiErrors.length,
    apiErrors: apiErrors.slice(0, 50),
    health,
    logPath: logger.logPath,
    scenarioPath: path.join(args.outDir, 'ui_chaos_scenarios.json'),
  };
  fs.writeFileSync(path.join(args.outDir, 'ui_chaos_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  logger.write('ui_chaos_completed', summary);
  await browser.close();
  if (!args.allowErrors && (errors.length || apiErrors.length || health.ok !== true)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildScenarioPlan,
  summarizeApiPayload,
  parseArgs,
  usage,
  selectTargetWorkspace,
};
