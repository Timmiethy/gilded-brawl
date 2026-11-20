// Procedural 2.5D pixel-art sprite generator (crisp 16x16 sprites + portraits for all 10 heroes)
import { CHARACTERS } from '/shared/characters.js';

// Each character gets a distinct 16x16 pixel silhouette & palette!
// Palette tokens:
// . = transparent, O = dark outline (#141118), C = coat/head, S = secondary/outfit,
// A = accent/gear, E = dark eye (#120f16), W = white highlight, G = gold (#ffe082), H = skin/snout

const TEMPLATES = {
  // Tibo: iconic round white head, dark oval eyes, black gilded tunic, gold crown pin
  tibo: [
    '......GGGG......',
    '.....OOOOOO.....',
    '....OCCCCCC0....',
    '...OCCCCCCCCO...',
    '...OCCECCECCO...',
    '...OCCECCECCO...',
    '...OCCCCCCCCO...',
    '....OCCCCCC0....',
    '....OSSSSSSO....',
    '...OASSGSSSAA...',
    '...OSSSSSSSSA...',
    '...OSSSSSSSSO...',
    '....OSSSSSSO....',
    '....OO....OO....',
    '....OO....OO....',
    '................',
  ],
  // Poteto: round glasses, pink bow, barrel mallet flair
  poteto: [
    '....AA....AA....',
    '...OAAOOOOAAO...',
    '...OCCCCCCCCO...',
    '..OCCCCCCCCCCO..',
    '..OCWEOCCOEWCO..',
    '..OCEEOCCOEECO..',
    '...OCCCCCCCCO...',
    '....OOCCCCOO....',
    '...OSSSSSSSSO...',
    '..OAASSSSSSAAO..',
    '..OSSSSSSSSSSO..',
    '...OSSSSSSSSO...',
    '....OSSSSSSO....',
    '....OO....OO....',
    '....OO....OO....',
    '................',
  ],
  // Biscuit: pointy corgi ears, fiery scarf, stubby paws
  biscuit: [
    '..OO........OO..',
    '.OCCO......OCCO.',
    '.OCWCOOOOOOCWCO.',
    '..OCCCCCCCCCCO..',
    '..OCCECCCECCCO..',
    '..OCWWCCCCWWCO..',
    '...OCWWWWWWCO...',
    '....OAAAAAAO....',
    '...OACCCCCCAO...',
    '...OCCCCCCCCO...',
    '...OCWWWWWWCO...',
    '....OCCCCCC0....',
    '....OO....OO....',
    '....OO....OO....',
    '................',
    '................',
  ],
  // Sir Reginald: plumed iron helm, wide bulldog jaw, gilded plate armor
  reginald: [
    '......AAAA......',
    '.....OAAAAO.....',
    '...OOOOOOOOOO...',
    '..OSSSSSSSSSSO..',
    '..OSCCCCCCCCSO..',
    '..OSCECCCCECSO..',
    '..OCCCCCCCCCCO..',
    '..OGGGGGGGGGGO..',
    '.OSSSSSSSSSSSSO.',
    '.OSGGSSSSSSGGSO.',
    '.OSSSSSSSSSSSSO.',
    '..OSSSSSSSSSSO..',
    '...OSSSSSSSSO...',
    '...OOO....OOO...',
    '...OOO....OOO...',
    '................',
  ],
  // Nyx: sleek greyhound ears, moonlit hood, glowing violet eyes
  nyx: [
    '...OO......OO...',
    '..OCCO....OCCO..',
    '..OCCC0OO0CCCO..',
    '...OCCCCCCCCO...',
    '...OCCACCECCO...',
    '...OCCACCACCO...',
    '....OCCCCCC0....',
    '...OSSSSSSSSO...',
    '..OACCCCCCCCAO..',
    '..OCCCCCCCCCCO..',
    '...OCCCCCCCCO...',
    '...OSSSSSSSSO...',
    '....OO....OO....',
    '....OO....OO....',
    '................',
    '................',
  ],
  // Mochi: fluffy shiba cheeks, frost crystal crown
  mochi: [
    '......AAAA......',
    '..OO..OAAO..OO..',
    '.OCCOOCCCCOOCCO.',
    '..OCCCCCCCCCCO..',
    '..OCCECCCECCCO..',
    '..OCWWWWWWWWCO..',
    '...OCCCCCCCCO...',
    '....OSSSSSSO....',
    '...OSCCCCCCSO...',
    '...OSSSSSSSSO...',
    '...OCCCCCCCCO...',
    '....OCCCCCC0....',
    '....OO....OO....',
    '....OO....OO....',
    '................',
    '................',
  ],
  // Baron Von Bark: tall vampire collar, crimson cape, fangs
  baron: [
    '..OO........OO..',
    '.OSSOOOOOOOOSSO.',
    '.OSCCCCCCCCCCSO.',
    '.OSCCACCCCACCSO.',
    '..OCCCCCCCCCCO..',
    '..OCCWCCCCWCCO..',
    '..OSSSSSSSSSSO..',
    '.OASSCCCCCCSSAO.',
    '.OSSSSSSSSSSSSO.',
    '.OSCCCCCCCCCCSO.',
    '..OSSSSSSSSSSO..',
    '...OSSSSSSSSO...',
    '....OO....OO....',
    '....OO....OO....',
    '................',
    '................',
  ],
  // Sparky: spiky lightning ears, voltaic goggles
  sparky: [
    '.OO...AAAA...OO.',
    '.OCOO.OAAO.OOCO.',
    '..OCCOOOOOOCCO..',
    '..OCCCCCCCCCCO..',
    '..OSWEOCCOEWSO..',
    '..OCCCCCCCCCCO..',
    '...OCCCCCCCCO...',
    '....OSSSSSSO....',
    '...OSACCCCASO...',
    '...OSSSSSSSSO...',
    '....OCCCCCC0....',
    '....OCCCCCC0....',
    '....OO....OO....',
    '....OO....OO....',
    '................',
    '................',
  ],
  // Moss: wolf ears, leafy druid hood, emerald cloak
  moss: [
    '..OO........OO..',
    '.OCCO..AA..OCCO.',
    '.OCCCOAAAAOCCCO.',
    '..OCCCCCCCCCCO..',
    '..OCCECCCECCCO..',
    '..OCCCCCCCCCCO..',
    '...OSSSSSSSSO...',
    '..OSSCCCCCCSSO..',
    '..OSSSSSSSSSSO..',
    '..OSCCCCCCCCSO..',
    '...OSSSSSSSSO...',
    '....OSSSSSSO....',
    '....OO....OO....',
    '....OO....OO....',
    '................',
    '................',
  ],
  // Waffle: floppy pug ears, wizard starlight hat, cosmic robe
  waffle: [
    '.......GG.......',
    '......OSSO......',
    '.....OSSSSO.....',
    '....OSSSSSSO....',
    '..OOGGGGGGGGOO..',
    '..OCCCCCCCCCCO..',
    '..OCCECCCECCCO..',
    '..OCCCWWWWCCCO..',
    '...OCCCCCCCCO...',
    '...OSSSSSSSSO...',
    '..OASSGSSSGAO...',
    '..OSSSSSSSSSSO..',
    '...OSSSSSSSSO...',
    '....OO....OO....',
    '....OO....OO....',
    '................',
  ],
};

function renderPixelGrid(grid, palette, scale = 3, stepOffset = 0) {
  const c = document.createElement('canvas');
  c.width = 16 * scale;
  c.height = 16 * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || !palette[ch]) continue;
      let dy = 0;
      // Subtle 2-frame leg/body bounce for walk cycle
      if (stepOffset !== 0 && y >= 13) {
        if ((x < 8 && stepOffset > 0) || (x >= 8 && stepOffset < 0)) dy = -1;
      } else if (stepOffset !== 0 && y < 13) {
        dy = -0.5;
      }
      ctx.fillStyle = palette[ch];
      ctx.fillRect(x * scale, Math.round((y + dy) * scale), scale, scale);
    }
  }
  return c;
}

const spriteCache = new Map();

export function getHeroSprites(charId) {
  if (spriteCache.has(charId)) return spriteCache.get(charId);
  const def = CHARACTERS.find((c) => c.id === charId) || CHARACTERS[0];
  const grid = TEMPLATES[def.id] || TEMPLATES.tibo;
  const palette = {
    O: '#141118',
    '0': '#141118',
    C: def.coat || '#f5efe6',
    S: def.secondary || '#2b2f3a',
    A: def.accent || '#ff7043',
    E: '#120f16',
    W: '#fffdf7',
    G: '#ffe082',
  };

  const idle = renderPixelGrid(grid, palette, 3, 0);
  const walkA = renderPixelGrid(grid, palette, 3, 1);
  const walkB = renderPixelGrid(grid, palette, 3, -1);

  // White hit-flash version
  const flashPalette = { ...palette };
  for (const k of Object.keys(flashPalette)) {
    if (k !== 'O' && k !== '0') flashPalette[k] = '#ffffff';
  }
  const flash = renderPixelGrid(grid, flashPalette, 3, 0);

  const portrait = renderPixelGrid(grid, palette, 4, 0).toDataURL();

  const bundle = { idle, walkA, walkB, flash, portrait };
  spriteCache.set(charId, bundle);
  return bundle;
}
