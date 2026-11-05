// Capture self-check. When capture is started on demand, page scripts have already run. A script that
// replaced a built-in (fetch, XMLHttpRequest, JSON, Function.prototype and similar) before DevForge
// wrapped it could see or alter what capture records. The panel checks a fixed list of built-ins in the
// page and uses this module for the list and the wording. Pure.
const DFTamper = (() => {
  // Paths from window. Each must still be a native function.
  const PATHS = [
    'fetch', 'XMLHttpRequest', 'XMLHttpRequest.prototype.open', 'XMLHttpRequest.prototype.send', 'XMLHttpRequest.prototype.setRequestHeader',
    'WebSocket', 'EventSource', 'navigator.sendBeacon',
    'Function.prototype.call', 'Function.prototype.apply', 'Function.prototype.bind', 'Function.prototype.toString',
    'JSON.parse', 'JSON.stringify', 'Object.defineProperty', 'Object.getOwnPropertyDescriptor', 'Reflect.apply',
    'String.prototype.charCodeAt', 'Array.prototype.push', 'Array.prototype.some', 'RegExp.prototype.test', 'Promise.prototype.then',
  ];

  // found: the paths that are no longer native. Returns a notice for the Network tab, or null.
  function notice(found) {
    const list = [...new Set((found || []).filter((p) => PATHS.includes(p)))];
    if (!list.length) return null;
    return {
      list,
      title: 'The page replaced built-in functions before capture started',
      text:
        'These were no longer native when you pressed Start capture: ' + list.join(', ') + '. Frameworks and analytics scripts do this too, so it is not always hostile. ' +
        'Capture still runs, but a script that got there first could see or change what DevForge records. For the strongest capture, tick "From page start" and reload the page.',
    };
  }
  return { PATHS, notice };
})();
if (typeof module !== 'undefined') module.exports = DFTamper;
