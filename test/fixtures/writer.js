// Child process for test 6: opens the file and saves the known versions in a tight loop
// until it is SIGKILLed. Prints READY once the store is open.
import { FileStore } from '../../src/core/FileStore.js'
import { versions } from './versions.js'

const [file, backupRoot] = process.argv.slice(2)
const store = await FileStore.open(file, { backupRoot })
const start = versions.indexOf(store.text)
process.stdout.write('READY\n')
for (let i = start + 1; ; i++) {
  await store.save(versions[i % versions.length])
}
