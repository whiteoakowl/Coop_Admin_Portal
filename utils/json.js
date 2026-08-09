// Serializes a value for embedding inside a <script type="application/json">
// tag. Plain JSON.stringify() output can contain a literal "</script"
// sequence (e.g. a saved name tag/schedule card template with that text in
// a custom label), which would terminate the tag early and break the page -
// or, if attacker-controlled text made it in, run arbitrary script. Escaping
// "<" as its JSON unicode escape prevents that while still parsing back to
// the exact same value on the client.
function jsonScriptSafe(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

module.exports = { jsonScriptSafe };
