// Recoverable local multi-key writes. The journal is retained until every value
// has been written. Replay writes the same values, never re-grades an attempt.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {}).persistence = factory();
})(typeof self !== 'undefined' ? self : this, function() {
  function recover(store, prefix) {
    var key = prefix + 'psat_pending_write';
    try {
      var raw = store.getItem(key);
      if (!raw) return {success:true};
      var journal = JSON.parse(raw);
      if (!journal || !Array.isArray(journal.writes) || journal.version !== 1) throw Error('Unrecognized recovery journal; preserved for recovery');
      journal.writes.forEach(function(w) {
        if (!w || typeof w.key !== 'string' || !w.key.startsWith(prefix + 'psat_') || w.key === key || typeof w.value !== 'string') throw Error('Invalid recovery entry');
      });
      journal.writes.forEach(function(w) { store.setItem(w.key, w.value); });
      store.removeItem(key);
      return {success:true, recovered:true};
    } catch(e) { return {success:false, error:e.message}; }
  }
  function writeBatch(store, prefix, values) {
    var prior = recover(store, prefix);
    if (!prior.success) return prior;
    try {
      var writes = Object.keys(values).map(function(k) { return {key:prefix+k, value:JSON.stringify(values[k])}; });
      store.setItem(prefix+'psat_pending_write', JSON.stringify({version:1,writes:writes}));
    } catch(e) { return {success:false,error:e.message}; }
    return recover(store,prefix);
  }
  return {writeBatch:writeBatch,recover:recover};
});
