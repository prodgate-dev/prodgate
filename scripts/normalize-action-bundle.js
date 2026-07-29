// Normalize the ncc-generated bundle to LF line endings so the committed file is
// identical whether it was built on Windows or Linux, keeping the CI reproducibility
// check (git diff --exit-code action/) green on every host.
const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, '..', 'action', 'index.js')
const text = fs.readFileSync(file, 'utf8')
const normalized = text.replace(/\r\n/g, '\n')
if (normalized !== text) {
  fs.writeFileSync(file, normalized)
}
