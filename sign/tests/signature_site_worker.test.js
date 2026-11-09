const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SignatureSiteWorker,
  decodeImageDataUrl,
  pickGeneratedSignatureImage,
} = require('../lib/signature_site_worker');

test('decodeImageDataUrl returns the PNG payload buffer', () => {
  const payload = Buffer.from('signature-binary', 'utf8');
  const decoded = decodeImageDataUrl(`data:image/png;base64,${payload.toString('base64')}`);

  assert.deepEqual(decoded, payload);
});

test('pickGeneratedSignatureImage picks one usable result by random index', () => {
  const first = { img_url: 'data:image/png;base64,AAA=', canvas_width: 220, uuid: 'a' };
  const second = { img_url: 'data:image/png;base64,BBB=', canvas_width: 360, uuid: 'b' };
  const third = { img_url: 'data:image/png;base64,CCC=', canvas_width: 300, uuid: 'c' };

  assert.equal(
    pickGeneratedSignatureImage([first, second, third], 'any-style', () => 0.5),
    second
  );
});

test('pickGeneratedSignatureImage ignores unusable results before random selection', () => {
  const unusable = { img_url: '', canvas_width: 999, uuid: 'bad' };
  const first = { img_url: 'data:image/png;base64,AAA=', canvas_width: 220, uuid: 'a' };
  const second = { img_url: 'data:image/png;base64,BBB=', canvas_width: 420, uuid: 'b' };

  assert.equal(
    pickGeneratedSignatureImage([unusable, first, second], 'any-style', () => 0.99),
    second
  );
});

test('processJob fetches fresh candidates instead of reusing a name cache', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signature-site-worker-'));
  const originalFetch = global.fetch;
  let callCount = 0;

  t.after(() => {
    global.fetch = originalFetch;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  global.fetch = async () => {
    callCount += 1;
    const payload = Buffer.from(`signature-${callCount}`, 'utf8').toString('base64');
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          images: [
            {
              img_url: `data:image/png;base64,${payload}`,
              canvas_width: 320,
              uuid: String(callCount),
            },
          ],
        },
      }),
    };
  };

  const worker = new SignatureSiteWorker({
    storageRoot,
    apiUrl: 'https://example.test/api/gen-signature',
  });

  const firstResult = await worker.processJob({ chineseName: '张三', signatureStyle: 'any-style' });
  const secondResult = await worker.processJob({ chineseName: '张三', signatureStyle: 'any-style' });

  assert.equal(callCount, 2);
  assert.notEqual(firstResult.cachePath, secondResult.cachePath);
});
