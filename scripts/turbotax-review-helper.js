const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const REVIEW_TABLE_HEADING = /Review your CoinLedger sales|Take a moment to review your CoinLedger sales/i;
const REVIEW_FORM_HEADING = /Review this CoinLedger sale/i;
const SITUATIONS_HEADING = /Let us know if any of these situations apply/i;
const COST_BASIS_HEADING = /Let.?s find your cost basis/i;
const COST_BASIS_OPTION = /I don.?t want to make any changes to my cost basis right now/i;
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts');
const MAX_ATTEMPTS_PER_ROW = 2;

let activePage;
let lastFailureContext = null;
let runLogPath = null;
let runProgress = null;
let runStartedAt = null;

const FIELD_LOGIC = {
  determineInvestmentType({ assetName }) {
    if (assetName.toUpperCase().includes('USDC')) {
      return 'Stablecoin';
    }

    return 'Regular digital asset';
  },

  determineHowReceived() {
    return 'I purchased it';
  }
};

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

async function ensureArtifactsDir() {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
}

async function appendRunLog(level, message) {
  if (!runLogPath) {
    return;
  }

  const timestamp = new Date().toISOString();
  await fs.appendFile(runLogPath, `[${timestamp}] ${level} ${message}\n`, 'utf8');
}

function formatLogMessage(values) {
  return values.map((value) => {
    if (value instanceof Error) {
      return value.stack || value.message;
    }

    if (typeof value === 'string') {
      return value;
    }

    return JSON.stringify(value);
  }).join(' ');
}

async function logInfo(...values) {
  const message = formatLogMessage(values);
  console.log(message);
  await appendRunLog('INFO ', message);
}

async function logError(...values) {
  const message = formatLogMessage(values);
  console.error(message);
  await appendRunLog('ERROR', message);
}

async function saveFailureArtifacts(page, label, context = {}) {
  await ensureArtifactsDir();

  const timestamp = Date.now();
  const assetSlug = slugify(context.assetName || context.rowSummary || label);
  const basePath = path.join(ARTIFACTS_DIR, `${timestamp}-${assetSlug}`);

  await page.screenshot({ path: `${basePath}.png`, fullPage: true });
  await fs.writeFile(`${basePath}.html`, await page.content(), 'utf8');

  await logError(`Saved failure screenshot to ${basePath}.png`);
  await logError(`Saved failure HTML to ${basePath}.html`);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

async function getPendingReviewCount(page) {
  const bodyText = await page.locator('body').textContent().catch(() => '');
  const bannerMatch = bodyText && bodyText.match(/(\d+)\s+items?\s+that\s+need\s+review/i);

  if (bannerMatch) {
    return Number.parseInt(bannerMatch[1], 10);
  }

  const visibleRows = await page.locator('tr:has-text("NEEDS REVIEW")').count().catch(() => 0);
  return visibleRows;
}

async function logRunSummary(status, page, progress) {
  const elapsedMs = Date.now() - runStartedAt;
  const averageMsPerRow = progress.processedCount > 0 ? elapsedMs / progress.processedCount : 0;
  let remainingCount = null;

  if (page) {
    remainingCount = await getPendingReviewCount(page).catch(() => null);
  }

  if (remainingCount == null && progress.totalRowsAtStart != null) {
    remainingCount = Math.max(progress.totalRowsAtStart - progress.processedCount, 0);
  }

  await logInfo(`Run summary (${status})`);
  await logInfo(`Rows corrected: ${progress.processedCount}`);
  await logInfo(`Rows remaining: ${remainingCount == null ? 'unknown' : remainingCount}`);
  await logInfo(`Retries used: ${progress.retryCount}`);
  await logInfo(`Rows at start: ${progress.totalRowsAtStart == null ? 'unknown' : progress.totalRowsAtStart}`);
  await logInfo(`Total time: ${formatDuration(elapsedMs)}`);
  await logInfo(`Average time per corrected row: ${progress.processedCount > 0 ? formatDuration(averageMsPerRow) : 'n/a'}`);
}

async function waitForAnyVisible(locators, timeout = 30000) {
  return Promise.any(
    locators.map(async ({ name, locator }) => {
      await locator.first().waitFor({ state: 'visible', timeout });
      return name;
    })
  );
}

async function waitForReviewForm(page, timeout = 30000) {
  await waitForAnyVisible([
    { name: 'heading', locator: page.getByText(REVIEW_FORM_HEADING) },
    { name: 'typeQuestion', locator: page.getByText(/What type of investment did you sell\?/i) },
    { name: 'receiveQuestion', locator: page.getByText(/How did you receive this investment\?/i) }
  ], timeout);
}

async function waitForTable(page, timeout = 30000) {
  await page.getByText(REVIEW_TABLE_HEADING).first().waitFor({ state: 'visible', timeout });
}

async function getFirstVisible(locator) {
  const count = await locator.count();

  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);

    if (await candidate.isVisible()) {
      return candidate;
    }
  }

  return null;
}

async function getVisibleText(locator) {
  const target = await getFirstVisible(locator);

  if (!target) {
    return '';
  }

  const text = await target.textContent();
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function clickAndWaitForReviewForm(page, target, description) {
  await target.click();

  try {
    await waitForReviewForm(page, 5000);
    await logInfo(`Opened review form via ${description}.`);
    return true;
  } catch {
    await logInfo(`Clicked ${description}, but the review form did not open.`);
    return false;
  }
}

async function openReviewFromFirstPendingRow(page) {
  const row = page.locator('tr:has-text("NEEDS REVIEW")').first();
  await row.waitFor({ state: 'visible' });

  const rowSummary = await getVisibleText(row.locator('td, [role="cell"]'));
  await logInfo(`Opening row: ${rowSummary}`);

  const cellLocator = row.locator('td, [role="cell"]');
  const actionCellCount = await cellLocator.count();
  const lastCell = actionCellCount > 0 ? cellLocator.nth(actionCellCount - 1) : row;
  const secondToLastCell = actionCellCount > 1 ? cellLocator.nth(actionCellCount - 2) : row;

  const candidates = [
    {
      description: 'named edit/review button',
      locator: row.getByRole('button', { name: /edit|review/i })
    },
    {
      description: 'button with edit metadata',
      locator: row.locator('button[aria-label*="Edit" i], button[title*="Edit" i], button[data-testid*="edit" i]')
    },
    {
      description: 'button in penultimate action cell',
      locator: secondToLastCell.locator('button')
    },
    {
      description: 'button in final action cell',
      locator: lastCell.locator('button')
    },
    {
      description: 'first visible button in row',
      locator: row.locator('button')
    }
  ];

  for (const candidate of candidates) {
    const target = await getFirstVisible(candidate.locator);

    if (!target) {
      continue;
    }

    if (await clickAndWaitForReviewForm(page, target, candidate.description)) {
      return { rowSummary };
    }
  }

  throw new Error('Could not open the first NEEDS REVIEW row.');
}

async function findSelectAfterQuestion(page, questionPattern) {
  const question = page.getByText(questionPattern).first();
  const directSelect = question.locator('xpath=following::select[1]');

  if (await directSelect.count() > 0) {
    return directSelect.first();
  }

  const fallbackSelect = page.locator('select');
  const selectCount = await fallbackSelect.count();

  if (selectCount === 0) {
    throw new Error(`Could not find select for question matching ${questionPattern}.`);
  }

  return fallbackSelect.first();
}

async function setSelectValue(page, questionPattern, label) {
  const select = await findSelectAfterQuestion(page, questionPattern);
  await select.selectOption({ label });
}

async function clickVisibleText(page, pattern) {
  const locator = page.getByText(pattern).first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.click();
}

async function clickContinue(page) {
  const button = page.getByRole('button', { name: /^Continue$/ }).first();
  await button.waitFor({ state: 'visible', timeout: 10000 });
  await button.click();
}

async function clickBack(page) {
  const button = page.getByRole('button', { name: /^Back$/ }).first();
  await button.waitFor({ state: 'visible', timeout: 10000 });
  await button.click();
}

async function waitForNextStep(page, timeout = 15000) {
  return waitForAnyVisible([
    { name: 'situations', locator: page.getByText(SITUATIONS_HEADING) },
    { name: 'costBasis', locator: page.getByText(COST_BASIS_HEADING) },
    { name: 'table', locator: page.getByText(REVIEW_TABLE_HEADING) }
  ], timeout);
}

async function recoverToTable(page) {
  for (let i = 0; i < 3; i += 1) {
    if (await page.getByText(REVIEW_TABLE_HEADING).first().isVisible().catch(() => false)) {
      return true;
    }

    const backButton = page.getByRole('button', { name: /^Back$/ }).first();
    if (await backButton.isVisible().catch(() => false)) {
      await clickBack(page);
      await page.waitForTimeout(1000);
      continue;
    }

    break;
  }

  return await page.getByText(REVIEW_TABLE_HEADING).first().isVisible().catch(() => false);
}

async function processTransaction(page, transactionContext) {
  await waitForReviewForm(page);

  const assetField = page.getByLabel(/Name of digital asset/i).first();
  const assetName = (await assetField.inputValue()).trim();
  transactionContext.assetName = assetName;

  await setSelectValue(
    page,
    /What type of investment did you sell\?/i,
    FIELD_LOGIC.determineInvestmentType(transactionContext)
  );

  await setSelectValue(page, /How did you receive this investment\?/i, FIELD_LOGIC.determineHowReceived(transactionContext));
  await clickContinue(page);

  let nextStep = await waitForNextStep(page);

  if (nextStep === 'situations') {
    await clickVisibleText(page, /^None of these apply$/);
    await clickContinue(page);
    nextStep = await waitForNextStep(page);
  }

  if (nextStep === 'costBasis') {
    await clickVisibleText(page, COST_BASIS_OPTION);
    await clickContinue(page);
    nextStep = await waitForNextStep(page);
  }

  if (nextStep !== 'table') {
    throw new Error(`Unexpected next step after transaction review: ${nextStep}`);
  }
}

async function processSingleTransaction(page, progress) {
  let transactionContext = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ROW; attempt += 1) {
    transactionContext = {
      attempt,
      rowSummary: '',
      assetName: '',
      processedCount: progress.processedCount,
      retryCount: progress.retryCount
    };

    try {
      const openedRow = await openReviewFromFirstPendingRow(page);
      transactionContext.rowSummary = openedRow.rowSummary;

      await processTransaction(page, transactionContext);
      progress.processedCount += 1;
      await logInfo(
        `Completed ${progress.processedCount} transaction(s). Asset: ${transactionContext.assetName || transactionContext.rowSummary}`
      );
      return;
    } catch (error) {
      lastFailureContext = { ...transactionContext, message: error.message };
      await logError(
        `Transaction attempt ${attempt}/${MAX_ATTEMPTS_PER_ROW} failed for ${transactionContext.assetName || transactionContext.rowSummary || 'unknown row'}.`
      );
      await logError(error);
      await saveFailureArtifacts(page, 'transaction-failure', transactionContext);

      if (attempt === MAX_ATTEMPTS_PER_ROW) {
        throw error;
      }

      progress.retryCount += 1;
      await logInfo('Attempting to recover to the review table and retry this row once.');

      if (!await recoverToTable(page)) {
        throw new Error('Could not return to the review table for retry.');
      }

      await waitForTable(page, 15000);
    }
  }
}

async function processCurrentTablePage(page, progress) {
  while (true) {
    const pendingRows = page.locator('tr:has-text("NEEDS REVIEW")');
    const count = await pendingRows.count();

    if (count === 0) {
      return;
    }

    await logInfo(
      `Processing next transaction (${count} remaining on this table page, ${progress.processedCount} completed overall, ${progress.retryCount} retried).`
    );
    await processSingleTransaction(page, progress);
    await waitForTable(page, 15000);
  }
}

async function goToNextTablePage(page) {
  const pagerCandidates = [
    page.locator('[aria-label*="next" i]'),
    page.getByRole('button', { name: /^>$/ }),
    page.getByRole('button', { name: /next/i }),
    page.getByText(/^>$/)
  ];

  for (const candidate of pagerCandidates) {
    const target = await getFirstVisible(candidate);

    if (!target) {
      continue;
    }

    const isDisabled = await target.isDisabled().catch(() => false);

    if (isDisabled) {
      return false;
    }

    await target.click();
    await page.waitForTimeout(1500);
    await waitForTable(page, 15000);
    return true;
  }

  return false;
}

function buildRunLogPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ARTIFACTS_DIR, `run-${timestamp}.log`);
}

async function main() {
  await ensureArtifactsDir();
  runLogPath = buildRunLogPath();
  await fs.writeFile(runLogPath, '', 'utf8');
  await logInfo(`Run log: ${runLogPath}`);
  runStartedAt = Date.now();

  const browser = await chromium.launch({
    headless: false,
    slowMo: 150
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  activePage = page;

  await logInfo('👉 Navigate to TurboTax and log in, then go to the CoinLedger review table.');
  await page.goto('https://turbotax.intuit.com/');
  await page.pause();

  await waitForTable(page);
  const progress = {
    processedCount: 0,
    retryCount: 0,
    totalRowsAtStart: await getPendingReviewCount(page)
  };
  runProgress = progress;

  while (true) {
    await processCurrentTablePage(page, progress);

    if (!await goToNextTablePage(page)) {
      await logInfo(`✅ Done! Processed ${progress.processedCount} transaction(s) with ${progress.retryCount} retrie(s).`);
      await logRunSummary('success', page, progress);
      break;
    }

    await logInfo('➡️ Moving to next page...');
  }
}

main().catch(async (error) => {
  await logError(error);

  if (activePage) {
    try {
      await saveFailureArtifacts(activePage, 'fatal-error', lastFailureContext || {});
    } catch (screenshotError) {
      await logError('Could not save a failure screenshot.');
      await logError(screenshotError);
    }
  }

  if (runProgress) {
    await logRunSummary('failed', activePage, runProgress);
  }

  process.exitCode = 1;
});
