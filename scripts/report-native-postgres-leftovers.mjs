import {inspectNativePostgresLeftovers} from '../tests/helpers/inventory-native-postgres.mjs';
// Reporting only. No processes are stopped and no data is deleted.
console.log(JSON.stringify(inspectNativePostgresLeftovers(),null,2));
