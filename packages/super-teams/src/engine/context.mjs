import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve, parse, relative, isAbsolute } from 'node:path';

const hash = data => createHash('sha256').update(data).digest('hex');
const size = text => Buffer.byteLength(text, 'utf8');
const limitations = ['Extractive UTF-8 byte selection, not semantic compression.', 'Only explicitly marked critical sources are guaranteed verbatim; omitted text may contain important details.'];
const snapshotRoot = 'context-sources';
const readerPath = `${snapshotRoot}/read-source.cjs`;
const readerSource = readFileSync(new URL('./source-reader.cjs', import.meta.url));
const readerHash = hash(readerSource);
const logKinds = new Set(['log','stdout','stderr']);
const shellQuote = text => `'${text.replaceAll("'", "''")}'`;
const snapshotLimitations = 'Attempt snapshots are independent copies, not immutable: the worker can rewrite them. Their SHA-256 is checked before dispatch; verify it again when reading. Snapshot edits do not update the original store.';

function safeDirectory(directory) {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const segment of relative(current, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Snapshot directory is linked or not a directory');
  }
  return absolute;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
}

function string(value, name) {
  if (typeof value !== 'string' || !value.isWellFormed()) throw new TypeError(`${name} must be a well-formed Unicode string`);
}

// Decode only complete UTF-8 code points; Buffer input originates from validated strings.
function prefix(buffer, limit) {
  let end = Math.min(buffer.length, limit);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

function selectSource(data, limit, kind) {
  const mode=logKinds.has(kind)?'head-tail':'prefix';
  if(limit>=data.length)return {text:data.toString('utf8'),includedBytes:data.length,selection:'full',windows:data.length?[{offset:0,bytes:data.length}]:[]};
  if(mode==='prefix'){
    const text=prefix(data,limit),bytes=size(text);
    return {text,includedBytes:bytes,selection:mode,windows:bytes?[{offset:0,bytes}]:[]};
  }
  const head=prefix(data,Math.floor(limit*.2)),headBytes=size(head);
  let start=Math.max(headBytes,data.length-(limit-headBytes));
  while(start<data.length&&(data[start]&0xc0)===0x80)start++;
  const tail=data.subarray(start).toString('utf8'),tailBytes=size(tail),windows=[];
  if(headBytes)windows.push({offset:0,bytes:headBytes});
  if(tailBytes)windows.push({offset:start,bytes:tailBytes});
  return {text:headBytes+tailBytes?`${head}\n[OMITTED middle bytes; offset=${headBytes}; endOffset=${start}]\n${tail}`:'',includedBytes:headBytes+tailBytes,selection:mode,windows};
}

function budgetBreakdown(parts) {
  const order=(a,b)=>b.bytes-a.bytes||(a.id<b.id?-1:a.id>b.id?1:0);
  const sorted=parts.filter(part=>part.bytes>0).sort(order);
  if(sorted.length<=20)return sorted;
  return [...sorted.slice(0,19),{id:'other',bytes:sorted.slice(19).reduce((sum,part)=>sum+part.bytes,0)}].sort(order);
}

export class ContextBudgetError extends RangeError {
  constructor({budgetBytes,requiredBytes,budgetBreakdown}) {
    super(`Context budget cannot fit mandatory content: requires ${requiredBytes} UTF-8 bytes; budget ${budgetBytes}; over by ${requiredBytes-budgetBytes}`);
    this.name='ContextBudgetError';this.code='CONTEXT_BUDGET_EXCEEDED';
    this.budgetBytes=budgetBytes;this.requiredBytes=requiredBytes;this.overByBytes=requiredBytes-budgetBytes;this.budgetBreakdown=budgetBreakdown;
  }
}

export function compactResult({ text, maxBytes = 4096 }) {
  string(text, 'text');
  integer(maxBytes, 'maxBytes');
  const original = Buffer.from(text);
  const summary = prefix(original, maxBytes);
  return { text: summary, summary, bytes: size(summary), originalBytes: original.length, maxBytes,
    truncated: original.length > size(summary), mode: 'extractive', limitations: [...limitations] };
}

export class ContextStore {
  constructor(rootDir) {
    this.rootDir = resolve(rootDir);
    this.blobsDir = join(this.rootDir, 'blobs');
    this.sourcesDir = join(this.rootDir, 'sources');
    mkdirSync(this.blobsDir, { recursive: true });
    mkdirSync(this.sourcesDir, { recursive: true });
  }

  addSource({ text, label = '', kind = 'context', critical = false }) {
    string(text, 'text'); string(label, 'label'); string(kind, 'kind');
    if (typeof critical !== 'boolean') throw new TypeError('critical must be boolean');
    const data = Buffer.from(text);
    const sha256 = hash(data);
    const id = hash(JSON.stringify({ sha256, label, kind, critical }));
    const metadata = { id, sha256, bytes: data.length, label, kind, critical };
    const blobPath = join(this.blobsDir, `${sha256}.txt`);
    if (existsSync(blobPath)) {
      if (hash(readFileSync(blobPath)) !== sha256) throw new Error(`Source corruption: ${id}`);
    } else {
      writeFileSync(blobPath, data, { flag: 'wx' });
    }
    const sourcePath = join(this.sourcesDir, `${id}.json`);
    if (existsSync(sourcePath)) this._metadata(id);
    else writeFileSync(sourcePath, JSON.stringify(metadata), { flag: 'wx' });
    return { ...metadata };
  }

  _metadata(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid source id');
    const metadata = JSON.parse(readFileSync(join(this.sourcesDir, `${id}.json`), 'utf8'));
    const { sha256, label, kind, critical, bytes } = metadata;
    if (!/^[a-f0-9]{64}$/.test(sha256) || typeof label !== 'string' || typeof kind !== 'string'
      || typeof critical !== 'boolean' || !Number.isSafeInteger(bytes) || bytes < 0
      || metadata.id !== id || hash(JSON.stringify({ sha256, label, kind, critical })) !== id) {
      throw new Error(`Invalid source metadata: ${id}`);
    }
    return { id, sha256, bytes, label, kind, critical };
  }

  _data(metadata) {
    const data = readFileSync(join(this.blobsDir, `${metadata.sha256}.txt`));
    if (data.length !== metadata.bytes || hash(data) !== metadata.sha256) throw new Error(`Source corruption: ${metadata.id}`);
    return data;
  }

  listSources() {
    return readdirSync(this.sourcesDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .sort().map(name => this._metadata(name.slice(0, -5)));
  }

  verifySources(ids) {
    return [...new Set(ids)].map(id => {
      const metadata = this._metadata(id);
      this._data(metadata);
      return { id, sha256: metadata.sha256, valid: true };
    });
  }

  materializeSources(sourceIds, cwd) {
    const directory = safeDirectory(cwd);
    const sources = [...new Set(sourceIds)].map(id => {
      const metadata = this._metadata(id);
      return { metadata, data: this._data(metadata) };
    });
    // A new directory per attempt prevents reuse, link following, and overwriting prior evidence.
    mkdirSync(join(directory, snapshotRoot));
    writeFileSync(join(directory, readerPath), readerSource, { flag: 'wx' });
    const manifest = { version: 1, root: snapshotRoot, sources: [] };
    for (const { metadata, data } of sources) {
      const path = `${snapshotRoot}/${metadata.id}.txt`;
      writeFileSync(join(directory, path), data, { flag: 'wx' });
      manifest.sources.push({ ...metadata, path });
    }
    this.verifyMaterializedSources(manifest, directory);
    return manifest;
  }

  verifyMaterializedSources(manifest, cwd) {
    const directory = safeDirectory(cwd);
    this._snapshotRefs(manifest);
    safeDirectory(join(directory, snapshotRoot));
    const readerFile = join(directory, readerPath);
    const readerInfo = lstatSync(readerFile);
    if (readerInfo.isSymbolicLink() || !readerInfo.isFile() || readerInfo.nlink !== 1) throw new Error('Snapshot reader must be an independent regular file');
    if (hash(readFileSync(readerFile)) !== readerHash) throw new Error('Snapshot reader corruption');
    return manifest.sources.map(source => {
      const filename = join(directory, source.path);
      const info = lstatSync(filename);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('Snapshot must be an independent regular file');
      const data = readFileSync(filename);
      if (data.length !== source.bytes || hash(data) !== source.sha256) throw new Error(`Snapshot corruption: ${source.id}`);
      this._data(this._metadata(source.id));
      return { id: source.id, sha256: source.sha256, valid: true };
    });
  }

  _snapshotRefs(manifest) {
    if (!manifest || manifest.version !== 1 || manifest.root !== snapshotRoot || !Array.isArray(manifest.sources)) throw new Error('Invalid snapshot manifest');
    const refs = new Map();
    for (const source of manifest.sources) {
      const metadata = this._metadata(source.id);
      const expected = `${snapshotRoot}/${metadata.id}.txt`;
      if (typeof source.path !== 'string' || isAbsolute(source.path) || source.path !== expected
        || refs.has(source.id) || Object.keys(metadata).some(key => source[key] !== metadata[key])) throw new Error('Invalid snapshot reference');
      refs.set(source.id, { ...metadata, path: expected });
    }
    return refs;
  }

  readSource(id, { offset = 0, limit = 8192 } = {}) {
    integer(offset, 'offset'); integer(limit, 'limit');
    const metadata = this._metadata(id);
    const data = this._data(metadata);
    let start = Math.min(offset, data.length);
    while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
    const text = prefix(data.subarray(start), limit);
    if (!text && start < data.length) throw new RangeError('limit cannot fit the next UTF-8 code point');
    const end = start + size(text);
    return { id, text, offset: start, nextOffset: end < data.length ? end : null, totalBytes: data.length, sha256: metadata.sha256 };
  }

  buildPacket({ goal, sourceIds = [], budgetBytes = 16384, manifest, requiredSections = [] }) {
    string(goal, 'goal'); integer(budgetBytes, 'budgetBytes');
    if(!Array.isArray(requiredSections))throw new TypeError('requiredSections must be an array');
    const sectionIds=new Set();
    for(const section of requiredSections){
      string(section?.id,'required section id');string(section?.text,'required section text');
      if(!section.id||size(section.id)>64||sectionIds.has(section.id))throw new TypeError('Required section ids must be unique and contain 1 to 64 UTF-8 bytes');
      sectionIds.add(section.id);
    }
    const snapshotRefs = manifest === undefined ? null : this._snapshotRefs(manifest);
    const sources = [...new Set(sourceIds)].map(id => {
      const original = this._metadata(id);
      if (snapshotRefs && !snapshotRefs.has(id)) throw new Error(`Missing snapshot reference: ${id}`);
      const metadata = snapshotRefs?.get(id) ?? original;
      if (snapshotRefs) metadata.readCommand = `& ${shellQuote(process.execPath)} ${shellQuote(readerPath)} '${id}.txt' --sha256 ${metadata.sha256} --offset 0 --limit 8192`;
      return { metadata, data: this._data(metadata) };
    });
    const reading = snapshotRefs ? `\nLOCAL ORIGINALS\nSOURCE.path is relative to this attempt's working directory. Use each SOURCE.readCommand exactly: the trusted Node reader returns UTF-8-safe JSON windows and verifies SOURCE.sha256. Default window 8192 bytes; maximum 16384. Continue using --offset <nextOffset>. For the ending, replace --offset 0 with --tail; retain --limit. Read relevant omitted windows before drawing conclusions; do not dump the whole document. Garbled output, missing emoji, or a blocked shell method is not a completed read: use the provided Node reader command instead. ${snapshotLimitations}\n` : '';
    const selections = sources.map(({ metadata, data }) => selectSource(data,metadata.critical?data.length:0,metadata.kind));
    const header='MODE extractive; budgets are UTF-8 bytes. Only explicit critical flags guarantee verbatim preservation. Excerpts and omissions are not semantically complete.\nGOAL\n',footer='\nEND GOAL\n';
    const sourceBlock=({metadata},index)=>{
      const {text,includedBytes,selection,windows}=selections[index];
      const status=includedBytes===metadata.bytes?'full':includedBytes?'excerpt':'omitted';
      return `\nSOURCE ${JSON.stringify({...metadata,status,includedBytes,omittedBytes:metadata.bytes-includedBytes,selection,windows})}\n${text}\nEND SOURCE ${metadata.id}\n`;
    };
    const render = () => {
      return `${header}${goal}${footer}${requiredSections.map(section=>section.text).join('')}${reading}${sources.map(sourceBlock).join('')}`;
    };
    const requiredBytes=size(render()),breakdown=budgetBreakdown([
      {id:'packet-format',bytes:size(header+footer)},{id:'goal',bytes:size(goal)},{id:'reading-instructions',bytes:size(reading)},
      ...requiredSections.map(section=>({id:`required:${section.id}`,bytes:size(section.text)})),
      ...sources.flatMap((source,index)=>[{id:`source-metadata:${source.metadata.id}`,bytes:size(sourceBlock(source,index))-(source.metadata.critical?source.data.length:0)},...(source.metadata.critical?[{id:`critical-source:${source.metadata.id}`,bytes:source.data.length}]:[])])
    ]);
    if(requiredBytes>budgetBytes)throw new ContextBudgetError({budgetBytes,requiredBytes,budgetBreakdown:breakdown});
    // Allocate optional bytes fairly. Explicit logs favor the tail; documents retain prefixes.
    const optional = sources.map((source, index) => ({ ...source, index })).filter(source => !source.metadata.critical);
    for (let position = 0; position < optional.length; position++) {
      const source = optional[position];
      const available = Math.floor((budgetBytes - size(render())) / (optional.length - position));
      const target=budgetBytes-available*(optional.length-position-1);
      selections[source.index]=selectSource(source.data,source.data.length,source.metadata.kind);
      if(size(render())<=target)continue;
      selections[source.index]=selectSource(source.data,0,source.metadata.kind);
      let low = 0, high = Math.min(source.data.length, available + 32);
      // Metadata digit/status changes count toward the actual serialized packet budget.
      while (low < high) {
        const candidate = Math.ceil((low + high) / 2);
        selections[source.index] = selectSource(source.data,candidate,source.metadata.kind);
        if (size(render()) <= target) low = candidate;
        else high = candidate - 1;
      }
      selections[source.index] = selectSource(source.data,low,source.metadata.kind);
    }
    const text = render();
    const refs = sources.map(({ metadata }, index) => {const {includedBytes,selection,windows}=selections[index];return {...metadata,includedBytes,selection,windows};});
    const omitted = refs.filter(ref => ref.includedBytes < ref.bytes).map(ref => {
      const offset=ref.windows[0]?.offset===0?ref.windows[0].bytes:0,endOffset=ref.selection==='head-tail'&&ref.windows.at(-1)?.offset>0?ref.windows.at(-1).offset:ref.bytes;
      return {id:ref.id,omittedBytes:ref.bytes-ref.includedBytes,offset,nextOffset:offset,endOffset,reason:snapshotRefs?'UTF-8 byte budget; read the full local SOURCE.path and verify its SHA-256':'UTF-8 byte budget; original available through the host ContextStore.readSource API'};
    });
    return { text, refs, omitted, bytes: size(text), budgetBytes, requiredBytes, budgetBreakdown:breakdown, mode: 'extractive', limitations: [...limitations,'Log excerpts favor the head (20%) and tail (80%) by UTF-8 bytes; important middle facts can be omitted and require paged reading.', ...(snapshotRefs ? [snapshotLimitations] : [])] };
  }
}
