#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import MDBReader from 'mdb-reader';

const [, , filePath, tableName, ...extraArgs] = process.argv;

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage: npm start -- <file.accdb> [table]');
  process.exitCode = 2;
}

if (!filePath || extraArgs.length > 0 || filePath === '--help' || filePath === '-h') {
  usage(filePath === '--help' || filePath === '-h' ? undefined : 'An Access file is required and accepts at most one table argument.');
} else {
  try {
    const reader = new MDBReader(await readFile(filePath));
    const tables = reader.getTableNames();

    if (!tableName) {
      console.log(tables.join('\n'));
    } else {
      if (!tables.includes(tableName)) throw new Error(`No table named "${tableName}" found in the database.`);
      const columns = reader.getTable(tableName).getColumns();
      console.log(columns.map(column => `${column.name}\t${column.type}`).join('\n'));
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
