const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  createPaddlexModelRunner,
  parsePaddlexJsonOutput,
} = require('../lib/paddlex_model_runner');

test('parsePaddlexJsonOutput extracts the sentinel JSON line from noisy output', () => {
  const parsed = parsePaddlexJsonOutput([
    'ReduceMeanCheckIfOneDNNSupport noisy startup line',
    'PADDLEX_JSON_RESULT={"task":"image_classification","classes":[{"label":"receipt","score":0.91}]}',
    'INFO: Could not find files for the given pattern(s).',
  ].join('\n'));

  assert.equal(parsed.task, 'image_classification');
  assert.equal(parsed.classes[0].label, 'receipt');
});

test('createPaddlexModelRunner invokes the Python bridge for detection', async () => {
  let call;
  const runner = createPaddlexModelRunner({
    pythonExe: 'C:\\runtime\\python.exe',
    scriptPath: 'D:\\app\\sign\\scripts\\run_paddlex_model.py',
    execFile: (file, args, options, callback) => {
      call = { file, args, options };
      callback(null, 'PADDLEX_JSON_RESULT={"task":"object_detection","boxes":[{"label":"receipt_region","score":0.9,"coordinate":[1,2,3,4]}]}\n', '');
    },
  });

  const result = await runner.detectRegions({
    imagePath: 'D:\\images\\mix.jpg',
    modelDir: 'D:\\models\\det',
    modelName: 'PP-YOLOE_plus-L',
    threshold: 0.55,
  });

  assert.equal(result.task, 'object_detection');
  assert.equal(result.boxes[0].label, 'receipt_region');
  assert.equal(call.file, 'C:\\runtime\\python.exe');
  assert.deepEqual(call.args, [
    'D:\\app\\sign\\scripts\\run_paddlex_model.py',
    '--task',
    'object_detection',
    '--image',
    'D:\\images\\mix.jpg',
    '--model-dir',
    'D:\\models\\det',
    '--model-name',
    'PP-YOLOE_plus-L',
    '--threshold',
    '0.55',
  ]);
  assert.equal(call.options.windowsHide, true);
});

test('createPaddlexModelRunner invokes the Python bridge for classification', async () => {
  const runner = createPaddlexModelRunner({
    pythonExe: 'python.exe',
    scriptPath: 'runner.py',
    execFile: (file, args, options, callback) => {
      callback(null, 'PADDLEX_JSON_RESULT={"task":"image_classification","classes":[{"label":"passport","score":0.82}]}\n', '');
    },
  });

  const result = await runner.classifyImage({
    imagePath: 'passport.jpg',
    modelDir: 'cls',
    modelName: 'PP-HGNetV2-B6',
  });

  assert.equal(result.task, 'image_classification');
  assert.equal(result.classes[0].label, 'passport');
});

test('createPaddlexModelRunner writes a manifest for batch classification', async () => {
  let call;
  let manifestLines;
  const runner = createPaddlexModelRunner({
    pythonExe: 'python.exe',
    scriptPath: 'runner.py',
    execFile: (file, args, options, callback) => {
      call = { file, args, options };
      const manifestIndex = args.indexOf('--manifest');
      manifestLines = fs.readFileSync(args[manifestIndex + 1], 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
      callback(null, 'PADDLEX_JSON_RESULT={"task":"image_classification","results":[{"image":"a.jpg","classes":[{"label":"receipt","score":0.91}]},{"image":"b.jpg","classes":[{"label":"passport","score":0.82}]}]}\n', '');
    },
  });

  const result = await runner.classifyImages({
    imagePaths: ['a.jpg', 'b.jpg'],
    modelDir: 'cls',
    modelName: 'PP-HGNetV2-B6',
  });

  assert.equal(result.results.length, 2);
  assert.deepEqual(manifestLines, ['a.jpg', 'b.jpg']);
  assert.deepEqual(call.args.slice(0, 7), [
    'runner.py',
    '--task',
    'image_classification',
    '--manifest',
    call.args[4],
    '--model-dir',
    'cls',
  ]);
});

test('createPaddlexModelRunner writes a manifest for batch detection', async () => {
  let manifestLines;
  const runner = createPaddlexModelRunner({
    pythonExe: 'python.exe',
    scriptPath: 'runner.py',
    execFile: (file, args, options, callback) => {
      const manifestIndex = args.indexOf('--manifest');
      manifestLines = fs.readFileSync(args[manifestIndex + 1], 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
      callback(null, 'PADDLEX_JSON_RESULT={"task":"object_detection","results":[{"image":"a.jpg","boxes":[]},{"image":"b.jpg","boxes":[]}]}\n', '');
    },
  });

  const result = await runner.detectRegionsForImages({
    imagePaths: ['a.jpg', 'b.jpg'],
    modelDir: 'det',
    modelName: 'PP-YOLOE_plus-L',
    threshold: 0.3,
  });

  assert.equal(result.results.length, 2);
  assert.deepEqual(manifestLines, ['a.jpg', 'b.jpg']);
});

test('createPaddlexModelRunner uses the Python pool when no execFile override is supplied', async () => {
  let call;
  const runner = createPaddlexModelRunner({
    pythonExe: 'python.exe',
    scriptPath: 'runner.py',
    pythonPool: {
      async execute(scriptPath, args, options) {
        call = { scriptPath, args, options };
        return {
          stdout: 'PADDLEX_JSON_RESULT={"task":"image_classification","classes":[{"label":"other","score":0.51}]}\n',
          stderr: '',
        };
      },
    },
  });

  const result = await runner.classifyImage({
    imagePath: 'image.jpg',
    modelDir: 'cls',
    modelName: 'PP-HGNetV2-B6',
  });

  assert.equal(result.classes[0].label, 'other');
  assert.equal(call.scriptPath, 'runner.py');
  assert.deepEqual(call.args, [
    '--task',
    'image_classification',
    '--image',
    'image.jpg',
    '--model-dir',
    'cls',
    '--model-name',
    'PP-HGNetV2-B6',
  ]);
  assert.equal(call.options.pythonExe, 'python.exe');
});

test('parsePaddlexJsonOutput rejects output without the sentinel payload', () => {
  assert.throws(
    () => parsePaddlexJsonOutput('plain noise only'),
    /PaddleX JSON result/
  );
});
