// What each network in a folder of ONNX models takes, read from the model files themselves: writes
// <folder>/info.json, { <model name>: { inputNames, inputDims, bytes } }, an open dimension as -1.
// The service worker makes its readers from that file, so no network is loaded before a check runs
// it; the options page shows each network's size from it.
//
//   node model-info.mjs <folder>
import fs from "node:fs";
import path from "node:path";

/** The fields of one protobuf message: [field number, wire type, value], a length-delimited value as
 * the bytes it spans, a varint as a Number. */
function* fields(bytes) {
  let at = 0;
  const varint = () => {
    let value = 0;
    for (let scale = 1; ; scale *= 128) {
      const b = bytes[at++];
      if (b === undefined) throw new Error("model file ends inside a field");
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
    }
  };
  while (at < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) yield [field, wire, varint()];
    else if (wire === 1) { at += 8; yield [field, wire, null]; }
    else if (wire === 5) { at += 4; yield [field, wire, null]; }
    else if (wire === 2) { const n = varint(); yield [field, wire, bytes.subarray(at, at + n)]; at += n; }
    else throw new Error(`model file has wire type ${wire}`);
  }
}

const text = bytes => new TextDecoder().decode(bytes);
const first = (bytes, wanted) => { for (const [f, w, v] of fields(bytes)) if (f === wanted && w === 2) return v; return null; };

/** The inputs a model's graph takes, its initializers (weights listed as inputs by older exports) left
 * out, in the order ONNX Runtime lists them. */
export function inputsOf(bytes) {
  // ModelProto.graph = 7; GraphProto.initializer = 5, .input = 11; TensorProto.name = 8.
  const graph = first(bytes, 7);
  if (!graph) throw new Error("no graph in model file");
  const weights = new Set();
  const inputs = [];
  for (const [f, w, v] of fields(graph)) {
    if (w !== 2) continue;
    if (f === 5) { const name = first(v, 8); if (name) weights.add(text(name)); }
    if (f === 11) inputs.push(v);
  }
  const inputNames = [], inputDims = [];
  for (const input of inputs) {
    // ValueInfoProto.name = 1, .type = 2; TypeProto.tensor_type = 1; Tensor.shape = 2;
    // TensorShapeProto.dim = 1; Dimension.dim_value = 1 (varint), .dim_param = 2.
    const name = text(first(input, 1) ?? new Uint8Array());
    if (weights.has(name)) continue;
    const shape = first(first(first(input, 2) ?? new Uint8Array(), 1) ?? new Uint8Array(), 2) ?? new Uint8Array();
    const dims = [];
    for (const [f, w, dim] of fields(shape)) {
      if (f !== 1 || w !== 2) continue;
      let size = -1;
      // A negative dim_value (an int64 written as ten bytes) reads as open too.
      for (const [g, x, v] of fields(dim)) if (g === 1 && x === 0) size = v > Number.MAX_SAFE_INTEGER ? -1 : v;
      dims.push(size);
    }
    inputNames.push(name);
    inputDims.push(dims);
  }
  return { inputNames, inputDims };
}

if (process.argv[1] === import.meta.filename) {
  const folder = process.argv[2];
  const info = {};
  for (const file of fs.readdirSync(folder).filter(f => f.endsWith(".onnx")).sort()) {
    const bytes = fs.readFileSync(path.join(folder, file));
    info[file.slice(0, -5)] = { ...inputsOf(bytes), bytes: bytes.length };
  }
  fs.writeFileSync(path.join(folder, "info.json"), JSON.stringify(info));
  console.log(`info of ${Object.keys(info).length} models in ${path.join(folder, "info.json")}`);
}
