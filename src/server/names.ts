const NAMES = [
  'Juniper', 'Basalt', 'Kite', 'Willow', 'Cobalt', 'Maple', 'Ember', 'Quartz',
  'Fennel', 'Harbor', 'Indigo', 'Lark', 'Moss', 'Nimbus', 'Onyx', 'Pebble',
  'Rowan', 'Sable', 'Thistle', 'Umber', 'Vesper', 'Wren', 'Yarrow', 'Zephyr',
  'Aspen', 'Birch', 'Cedar', 'Dune', 'Elm', 'Flint', 'Garnet', 'Heron',
  'Iris', 'Jasper', 'Kestrel', 'Linden', 'Marlow', 'Nettle', 'Opal', 'Pine',
  'Quill', 'Reed', 'Sage', 'Tansy', 'Ulmo', 'Vale', 'Wisp', 'Xenon',
  'Yew', 'Zinnia', 'Alder', 'Briar', 'Clover', 'Drift', 'Egret', 'Fjord',
  'Glen', 'Hazel', 'Ivy', 'Jade', 'Koi', 'Lotus', 'Mica', 'Nova',
];

// FNV-1a 32-bit, stable across runs and platforms.
export function nameFor(sessionId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return NAMES[h % NAMES.length]!;
}
