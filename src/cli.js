// Small helper commands for running things by hand outside the container.
import { log } from './log.js';
import { runSync } from './sync.js';
import { listSheets, getSheet } from './smartsheet.js';
import { config } from './config.js';

const [command, arg] = process.argv.slice(2);

switch (command) {
  case 'sync': {
    const result = await runSync({ force: arg === '--force' });
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case 'sheets': {
    for (const s of await listSheets()) console.log(`${s.id}\t${s.name}`);
    break;
  }

  case 'columns': {
    const sheetId = arg ?? config.smartsheet.sheetId;
    if (!sheetId) { log.error('usage: npm run columns -- <sheetId>'); process.exit(1); }
    const sheet = await getSheet(sheetId);
    console.log(`${sheet.name} (${sheet.rows.length} rows)`);
    for (const c of sheet.columns) console.log(`  ${c.id}\t${c.title}`);
    break;
  }

  default:
    console.log('usage: node src/cli.js <sync [--force] | sheets | columns [sheetId]>');
    process.exit(1);
}
