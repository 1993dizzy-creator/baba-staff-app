import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

type CellValue = string | number | boolean | null;

type SheetRows = Map<number, Map<number, CellValue>>;

type ProductRow = {
  id: number;
  source: string | null;
  item_code: string | null;
  item_name: string | null;
  tax_rate: number | string | null;
  is_active: boolean | null;
};

type ParsedMenuRow = {
  rowNumber: number;
  itemCode: string;
  taxRate: number;
  rawTaxValue: CellValue;
};

type ProductMatch = {
  exportRow: ParsedMenuRow;
  product: ProductRow;
};

const DEFAULT_SQL_OUTPUT = "tmp/pos_products_tax_agent_export_update.sql";
const DEFAULT_CONFLICT_OUTPUT = "tmp/pos_products_tax_agent_export_conflicts.json";

function usage() {
  return [
    "Usage:",
    "  node scripts/generate-pos-product-tax-sql.ts <DANHMUCTHUCDON.xls> [--write-sql] [--out tmp/update.sql] [--conflicts tmp/conflicts.json]",
    "",
    "Default is dry-run only. Add --write-sql to write the SQL file.",
  ].join("\n");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const filePath = args.find((arg) => !arg.startsWith("--"));

  if (!filePath) {
    throw new Error(usage());
  }

  const getFlagValue = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  return {
    filePath: path.resolve(filePath),
    writeSql: args.includes("--write-sql"),
    debugRows: args.includes("--debug-rows"),
    sqlOutputPath: path.resolve(getFlagValue("--out", DEFAULT_SQL_OUTPUT)),
    conflictOutputPath: path.resolve(
      getFlagValue("--conflicts", DEFAULT_CONFLICT_OUTPUT)
    ),
  };
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex < 0) return;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!process.env[key]) process.env[key] = value;
    });
}

function getSupabaseClient() {
  loadEnvFile(path.resolve(".env.local"));
  loadEnvFile(path.resolve(".env"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  return createClient(url, key);
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .trim();
}

function cellToString(value: CellValue) {
  if (value === null) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  return String(value).trim();
}

function parseTaxRate(value: CellValue) {
  if (value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const rate = value > 0 && value < 1 ? value * 100 : value;
    return rate <= 100 ? rate : null;
  }

  const normalized = String(value)
    .replace("%", "")
    .replace(/\s+/g, "")
    .replace(",", ".");
  const match = normalized.match(/-?\d+(\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const rate = parsed > 0 && parsed < 1 ? parsed * 100 : parsed;
  return rate <= 100 ? rate : null;
}

function sameTaxRate(left: number | string | null, right: number) {
  const parsed = typeof left === "number" ? left : left === null ? null : Number(left);
  return parsed !== null && Number.isFinite(parsed) && Math.abs(parsed - right) < 0.0001;
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readUInt32(buffer: Buffer, offset: number) {
  return buffer.readUInt32LE(offset);
}

function readInt32(buffer: Buffer, offset: number) {
  return buffer.readInt32LE(offset);
}

function readOleStream(fileBuffer: Buffer, streamNames: string[]) {
  if (fileBuffer.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1") {
    throw new Error("Input is not an OLE2 .xls file.");
  }

  const sectorSize = 1 << fileBuffer.readUInt16LE(30);
  const miniSectorSize = 1 << fileBuffer.readUInt16LE(32);
  const firstDirectorySector = readInt32(fileBuffer, 48);
  const miniStreamCutoff = readUInt32(fileBuffer, 56);
  const firstMiniFatSector = readInt32(fileBuffer, 60);
  const miniFatSectorCount = readUInt32(fileBuffer, 64);
  const firstDifatSector = readInt32(fileBuffer, 68);
  const difatSectorCount = readUInt32(fileBuffer, 72);
  const difat: number[] = [];

  for (let offset = 76; offset < 512; offset += 4) {
    const sector = readInt32(fileBuffer, offset);
    if (sector >= 0) difat.push(sector);
  }

  let nextDifatSector = firstDifatSector;
  for (let i = 0; i < difatSectorCount && nextDifatSector >= 0; i += 1) {
    const sectorOffset = 512 + nextDifatSector * sectorSize;
    for (let offset = 0; offset < sectorSize - 4; offset += 4) {
      const sector = readInt32(fileBuffer, sectorOffset + offset);
      if (sector >= 0) difat.push(sector);
    }
    nextDifatSector = readInt32(fileBuffer, sectorOffset + sectorSize - 4);
  }

  const fat: number[] = [];
  difat.forEach((sector) => {
    const sectorOffset = 512 + sector * sectorSize;
    for (let offset = 0; offset < sectorSize; offset += 4) {
      fat.push(readInt32(fileBuffer, sectorOffset + offset));
    }
  });

  const readChain = (startSector: number, size?: number) => {
    const chunks: Buffer[] = [];
    let sector = startSector;
    const seen = new Set<number>();

    while (sector >= 0 && sector !== 0xfffffffe && !seen.has(sector)) {
      seen.add(sector);
      const sectorOffset = 512 + sector * sectorSize;
      chunks.push(fileBuffer.subarray(sectorOffset, sectorOffset + sectorSize));
      sector = fat[sector];
    }

    const result = Buffer.concat(chunks);
    return typeof size === "number" ? result.subarray(0, size) : result;
  };

  const directory = readChain(firstDirectorySector);
  const entries: {
    name: string;
    type: number;
    startSector: number;
    size: number;
  }[] = [];

  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = directory.readUInt16LE(offset + 64);
    if (nameLength < 2) continue;
    const name = directory
      .subarray(offset, offset + nameLength - 2)
      .toString("utf16le");
    entries.push({
      name,
      type: directory[offset + 66],
      startSector: readInt32(directory, offset + 116),
      size: readUInt32(directory, offset + 120),
    });
  }

  const root = entries.find((entry) => entry.type === 5);
  const target = entries.find((entry) =>
    streamNames.some((name) => entry.name.toLowerCase() === name.toLowerCase())
  );

  if (!target) {
    throw new Error(`Could not find workbook stream: ${streamNames.join(", ")}`);
  }

  if (target.size >= miniStreamCutoff || !root) {
    return readChain(target.startSector, target.size);
  }

  const miniFat = readChain(firstMiniFatSector, miniFatSectorCount * sectorSize);
  const miniStream = readChain(root.startSector, root.size);
  const chunks: Buffer[] = [];
  let sector = target.startSector;
  const seen = new Set<number>();

  while (sector >= 0 && sector !== 0xfffffffe && !seen.has(sector)) {
    seen.add(sector);
    const sectorOffset = sector * miniSectorSize;
    chunks.push(miniStream.subarray(sectorOffset, sectorOffset + miniSectorSize));
    sector = readInt32(miniFat, sector * 4);
  }

  return Buffer.concat(chunks).subarray(0, target.size);
}

function decodeRk(raw: number) {
  const dividedBy100 = (raw & 1) !== 0;
  const isInteger = (raw & 2) !== 0;
  let value: number;

  if (isInteger) {
    let integerValue = raw >> 2;
    if (integerValue & 0x20000000) integerValue -= 0x40000000;
    value = integerValue;
  } else {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(raw & 0xfffffffc, 4);
    value = buffer.readDoubleLE(0);
  }

  return dividedBy100 ? value / 100 : value;
}

function readBiffString(data: Buffer, offset: number) {
  const length = data.readUInt16LE(offset);
  const flags = data[offset + 2] || 0;
  const isUtf16 = (flags & 1) !== 0;
  let cursor = offset + 3;

  if ((flags & 8) !== 0) cursor += 2;
  if ((flags & 4) !== 0) cursor += 4;

  const byteLength = length * (isUtf16 ? 2 : 1);
  const text = data
    .subarray(cursor, cursor + byteLength)
    .toString(isUtf16 ? "utf16le" : "latin1");

  return { text, nextOffset: cursor + byteLength };
}

class SstReader {
  private chunkIndex = 0;
  private offset: number;
  private readonly chunks: Buffer[];

  constructor(chunks: Buffer[], startOffset: number) {
    this.chunks = chunks;
    this.offset = startOffset;
  }

  private moveToNextChunk() {
    this.chunkIndex += 1;
    this.offset = 0;
  }

  private ensureAvailable() {
    while (
      this.chunkIndex < this.chunks.length &&
      this.offset >= this.chunks[this.chunkIndex].length
    ) {
      this.moveToNextChunk();
    }

    if (this.chunkIndex >= this.chunks.length) {
      throw new Error("Unexpected end of SST data.");
    }
  }

  readUInt8() {
    this.ensureAvailable();
    const value = this.chunks[this.chunkIndex][this.offset];
    this.offset += 1;
    return value;
  }

  readUInt16() {
    const bytes = this.readBytes(2);
    return bytes.readUInt16LE(0);
  }

  readUInt32() {
    const bytes = this.readBytes(4);
    return bytes.readUInt32LE(0);
  }

  readBytes(length: number) {
    const chunks: Buffer[] = [];
    let remaining = length;

    while (remaining > 0) {
      this.ensureAvailable();
      const current = this.chunks[this.chunkIndex];
      const available = current.length - this.offset;
      const take = Math.min(remaining, available);
      chunks.push(current.subarray(this.offset, this.offset + take));
      this.offset += take;
      remaining -= take;
    }

    return Buffer.concat(chunks);
  }

  readCharacters(length: number, isUtf16Initial: boolean) {
    let remainingChars = length;
    let isUtf16 = isUtf16Initial;
    const parts: string[] = [];

    while (remainingChars > 0) {
      if (this.chunkIndex >= this.chunks.length) {
        throw new Error("Unexpected end of SST character data.");
      }

      if (this.offset >= this.chunks[this.chunkIndex].length) {
        this.moveToNextChunk();
        isUtf16 = (this.readUInt8() & 1) !== 0;
      }

      this.ensureAvailable();
      const current = this.chunks[this.chunkIndex];
      const bytesPerChar = isUtf16 ? 2 : 1;
      const availableChars = Math.floor((current.length - this.offset) / bytesPerChar);

      if (availableChars <= 0) {
        this.moveToNextChunk();
        isUtf16 = (this.readUInt8() & 1) !== 0;
        continue;
      }

      const takeChars = Math.min(remainingChars, availableChars);
      const takeBytes = takeChars * bytesPerChar;
      parts.push(
        current
          .subarray(this.offset, this.offset + takeBytes)
          .toString(isUtf16 ? "utf16le" : "latin1")
      );
      this.offset += takeBytes;
      remainingChars -= takeChars;

      if (remainingChars > 0 && this.offset >= current.length) {
        this.moveToNextChunk();
        isUtf16 = (this.readUInt8() & 1) !== 0;
      }
    }

    return parts.join("");
  }
}

function parseSst(chunks: Buffer[]) {
  const strings: string[] = [];
  if (chunks.length === 0 || chunks[0].length < 8) return strings;

  const uniqueStringCount = chunks[0].readUInt32LE(4);
  const reader = new SstReader(chunks, 8);

  while (strings.length < uniqueStringCount) {
    try {
      const length = reader.readUInt16();
      const flags = reader.readUInt8();
      const isUtf16 = (flags & 1) !== 0;
      const hasRichText = (flags & 8) !== 0;
      const hasExtended = (flags & 4) !== 0;
      const richRunCount = hasRichText ? reader.readUInt16() : 0;
      const extendedSize = hasExtended ? reader.readUInt32() : 0;
      const text = reader.readCharacters(length, isUtf16);

      if (richRunCount > 0) reader.readBytes(richRunCount * 4);
      if (extendedSize > 0) reader.readBytes(extendedSize);

      strings.push(text);
    } catch {
      break;
    }
  }

  return strings;
}

function setCell(rows: SheetRows, row: number, col: number, value: CellValue) {
  const cells = rows.get(row) || new Map<number, CellValue>();
  cells.set(col, value);
  rows.set(row, cells);
}

function parseWorkbookRows(workbook: Buffer) {
  const sstChunks: Buffer[] = [];
  const records: { id: number; data: Buffer; offset: number }[] = [];
  let offset = 0;

  while (offset + 4 <= workbook.length) {
    const id = workbook.readUInt16LE(offset);
    const length = workbook.readUInt16LE(offset + 2);
    const data = workbook.subarray(offset + 4, offset + 4 + length);
    records.push({ id, data, offset });
    offset += 4 + length;
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.id !== 0x00fc) continue;

    sstChunks.push(record.data);
    let nextIndex = index + 1;
    while (records[nextIndex]?.id === 0x003c) {
      sstChunks.push(records[nextIndex].data);
      nextIndex += 1;
    }
    break;
  }

  const sst = parseSst(sstChunks);
  const rows: SheetRows = new Map();
  let inWorksheet = false;

  records.forEach((record) => {
    if (record.id === 0x0809) {
      const bofType = record.data.length >= 4 ? record.data.readUInt16LE(2) : 0;
      inWorksheet = bofType === 0x0010;
      return;
    }

    if (!inWorksheet) return;

    if (record.id === 0x000a) {
      inWorksheet = false;
      return;
    }

    if (record.id === 0x00fd && record.data.length >= 10) {
      const row = record.data.readUInt16LE(0);
      const col = record.data.readUInt16LE(2);
      const sstIndex = record.data.readUInt32LE(6);
      setCell(rows, row, col, sst[sstIndex] ?? null);
      return;
    }

    if (record.id === 0x0203 && record.data.length >= 14) {
      setCell(
        rows,
        record.data.readUInt16LE(0),
        record.data.readUInt16LE(2),
        record.data.readDoubleLE(6)
      );
      return;
    }

    if (record.id === 0x027e && record.data.length >= 10) {
      setCell(
        rows,
        record.data.readUInt16LE(0),
        record.data.readUInt16LE(2),
        decodeRk(record.data.readUInt32LE(6))
      );
      return;
    }

    if (record.id === 0x00bd && record.data.length >= 8) {
      const row = record.data.readUInt16LE(0);
      const firstCol = record.data.readUInt16LE(2);
      const lastCol = record.data.readUInt16LE(record.data.length - 2);
      let cursor = 4;

      for (let col = firstCol; col <= lastCol && cursor + 6 <= record.data.length - 2; col += 1) {
        setCell(rows, row, col, decodeRk(record.data.readUInt32LE(cursor + 2)));
        cursor += 6;
      }
      return;
    }

    if (record.id === 0x0204 && record.data.length >= 8) {
      const row = record.data.readUInt16LE(0);
      const col = record.data.readUInt16LE(2);
      setCell(rows, row, col, readBiffString(record.data, 6).text);
    }
  });

  return rows;
}

function findHeader(rows: SheetRows) {
  const sortedRows = Array.from(rows.entries()).sort((left, right) => left[0] - right[0]);

  for (const [rowIndex, cells] of sortedRows.slice(0, 80)) {
    let codeCol: number | null = null;
    let taxCol: number | null = null;

    cells.forEach((value, colIndex) => {
      const normalized = normalizeText(value);
      const compact = normalized.replace(/\s+/g, "");

      if (
        codeCol === null &&
        (compact === "itemcode" ||
          compact === "productcode" ||
          compact === "mahang" ||
          compact === "mamon" ||
          compact === "mathucdon" ||
          normalized.includes("상품 코드") ||
          normalized.includes("품목 코드") ||
          normalized.includes("메뉴 코드"))
      ) {
        codeCol = colIndex;
      }

      if (
        taxCol === null &&
        (compact.includes("thuesuat") ||
          compact.includes("taxrate") ||
          compact.includes("vatrate") ||
          compact === "thue" ||
          compact === "thue*" ||
          normalized.includes("thuế suất") ||
          normalized === "thuế" ||
          normalized === "thue" ||
          normalized.includes("세율"))
      ) {
        taxCol = colIndex;
      }
    });

    if (codeCol !== null && taxCol !== null) {
      return { headerRow: rowIndex, codeCol, taxCol };
    }
  }

  throw new Error("Could not find item code and Thuế suất columns in the XLS file.");
}

function debugPrintRows(rows: SheetRows) {
  Array.from(rows.entries())
    .sort((left, right) => left[0] - right[0])
    .slice(0, 30)
    .forEach(([rowIndex, cells]) => {
      const values = Array.from(cells.entries())
        .sort((left, right) => left[0] - right[0])
        .slice(0, 20)
        .map(([colIndex, value]) => `${colIndex}:${cellToString(value)}`);
      console.log(`${rowIndex + 1}: ${values.join(" | ")}`);
    });
}

function parseMenuExport(filePath: string, debugRows: boolean) {
  const workbook = readOleStream(fs.readFileSync(filePath), ["Workbook", "Book"]);
  const rows = parseWorkbookRows(workbook);
  if (debugRows) debugPrintRows(rows);
  const header = findHeader(rows);
  const parsedRows: ParsedMenuRow[] = [];
  const invalidRows: { rowNumber: number; itemCode: string; rawTaxValue: CellValue }[] = [];

  Array.from(rows.entries())
    .sort((left, right) => left[0] - right[0])
    .forEach(([rowIndex, cells]) => {
      if (rowIndex <= header.headerRow) return;

      const itemCode = cellToString(cells.get(header.codeCol) ?? null).trim();
      const rawTaxValue = cells.get(header.taxCol) ?? null;
      const taxRate = parseTaxRate(rawTaxValue);

      if (!itemCode && rawTaxValue === null) return;
      if (!itemCode || taxRate === null) {
        invalidRows.push({ rowNumber: rowIndex + 1, itemCode, rawTaxValue });
        return;
      }

      parsedRows.push({
        rowNumber: rowIndex + 1,
        itemCode,
        taxRate,
        rawTaxValue,
      });
    });

  return {
    header,
    excelRowCount: Math.max(0, rows.size - header.headerRow - 1),
    parsedRows,
    invalidRows,
  };
}

function dedupeExportRows(rows: ParsedMenuRow[]) {
  const byCode = new Map<string, ParsedMenuRow[]>();
  rows.forEach((row) => {
    byCode.set(row.itemCode, [...(byCode.get(row.itemCode) || []), row]);
  });

  const usable = new Map<string, ParsedMenuRow>();
  const conflicts: {
    itemCode: string;
    rows: ParsedMenuRow[];
    taxRates: number[];
  }[] = [];

  byCode.forEach((codeRows, itemCode) => {
    const taxRates = Array.from(new Set(codeRows.map((row) => row.taxRate))).sort(
      (left, right) => left - right
    );

    if (taxRates.length > 1) {
      conflicts.push({ itemCode, rows: codeRows, taxRates });
      return;
    }

    usable.set(itemCode, codeRows[0]);
  });

  return { usable, duplicateConflicts: conflicts };
}

async function fetchProducts(itemCodes: string[]) {
  if (itemCodes.length === 0) return [];

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("pos_products")
    .select("id, source, item_code, item_name, tax_rate, is_active")
    .eq("source", "cukcuk")
    .in("item_code", itemCodes);

  if (error) {
    throw new Error(`Failed to fetch pos_products: ${error.message}`);
  }

  return (data || []) as ProductRow[];
}

function buildSql(updates: ProductMatch[]) {
  const lines = [
    "-- Generated by scripts/generate-pos-product-tax-sql.ts",
    "-- Policy: update source='cukcuk' rows only when tax_rate is null.",
    "begin;",
    "",
  ];

  updates.forEach(({ exportRow }) => {
    lines.push(
      [
        "update public.pos_products",
        "set",
        `  tax_rate = ${exportRow.taxRate},`,
        "  tax_rate_source = 'agent_export',",
        "  tax_rate_updated_at = now(),",
        "  tax_rate_conflict = false,",
        "  updated_at = now()",
        "where source = 'cukcuk'",
        `  and item_code = ${sqlString(exportRow.itemCode)}`,
        "  and tax_rate is null;",
        "",
      ].join("\n")
    );
  });

  lines.push("commit;", "");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs();
  const exportData = parseMenuExport(args.filePath, args.debugRows);
  const { usable, duplicateConflicts } = dedupeExportRows(exportData.parsedRows);
  const products = await fetchProducts(Array.from(usable.keys()));
  const productsByCode = new Map<string, ProductRow[]>();

  products.forEach((product) => {
    const itemCode = product.item_code?.trim();
    if (!itemCode) return;
    productsByCode.set(itemCode, [...(productsByCode.get(itemCode) || []), product]);
  });

  const updates: ProductMatch[] = [];
  const existingSameTaxRate: ProductMatch[] = [];
  const existingConflicts: (ProductMatch & { existingTaxRate: number | string | null })[] = [];
  const missingProducts: ParsedMenuRow[] = [];

  usable.forEach((exportRow, itemCode) => {
    const matchedProducts = productsByCode.get(itemCode) || [];
    if (matchedProducts.length === 0) {
      missingProducts.push(exportRow);
      return;
    }

    matchedProducts.forEach((product) => {
      if (product.tax_rate === null) {
        updates.push({ exportRow, product });
        return;
      }

      if (sameTaxRate(product.tax_rate, exportRow.taxRate)) {
        existingSameTaxRate.push({ exportRow, product });
        return;
      }

      existingConflicts.push({
        exportRow,
        product,
        existingTaxRate: product.tax_rate,
      });
    });
  });

  const conflictReport = {
    generatedAt: new Date().toISOString(),
    inputFile: args.filePath,
    duplicateExportConflicts: duplicateConflicts,
    existingTaxRateConflicts: existingConflicts.map((conflict) => ({
      itemCode: conflict.exportRow.itemCode,
      itemName: conflict.product.item_name,
      productId: conflict.product.id,
      excelTaxRate: conflict.exportRow.taxRate,
      existingTaxRate: conflict.existingTaxRate,
      excelRowNumber: conflict.exportRow.rowNumber,
    })),
    invalidRows: exportData.invalidRows.slice(0, 200),
    missingProducts: missingProducts.slice(0, 200),
  };

  ensureParentDir(args.conflictOutputPath);
  fs.writeFileSync(args.conflictOutputPath, JSON.stringify(conflictReport, null, 2));

  if (args.writeSql) {
    ensureParentDir(args.sqlOutputPath);
    fs.writeFileSync(args.sqlOutputPath, buildSql(updates));
  }

  const summary = {
    inputFile: args.filePath,
    headerRow: exportData.header.headerRow + 1,
    codeColumnIndex: exportData.header.codeCol,
    taxColumnIndex: exportData.header.taxCol,
    excelRowCount: exportData.excelRowCount,
    parsedTaxRateRowCount: exportData.parsedRows.length,
    duplicateExportConflictCount: duplicateConflicts.length,
    posProductsMatchedRowCount: products.length,
    updateableNullTaxRateProductCount: updates.length,
    existingSameTaxRateCount: existingSameTaxRate.length,
    existingDifferentTaxRateConflictCount: existingConflicts.length,
    missingProductCount: missingProducts.length,
    invalidRowCount: exportData.invalidRows.length,
    sqlWritten: args.writeSql ? args.sqlOutputPath : null,
    conflictReportWritten: args.conflictOutputPath,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
