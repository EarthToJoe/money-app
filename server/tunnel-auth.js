// Finch's tunnel gate: HTTP Basic auth for every request that did not come from
// the machine running Finch.
//
// WHY THIS EXISTS
// ---------------
// `npm run tunnel` puts a public https://<random>.trycloudflare.com address in
// front of the Vite dev server so Plaid's OAuth banks have somewhere to send the
// browser back to. That address is on the open internet. Before this file, an
// anonymous GET <tunnel>/api/plaid/status listed the user's linked banks and a
// POST <tunnel>/api/plaid/sync would have handed over their transactions to
// anyone who learned the hostname. Only /api/plaid/credentials and
// /api/plaid/redirect-uri were guarded, because they write .env.
//
// The gate below is the fix: one password, checked on every request that isn't
// local, installed both on the Vite dev server (which is what the tunnel points
// at) and on the Plaid backend (in case someone tunnels :8787 directly).
//
// WHY BASIC AUTH, AND WHY IT ALSO COVERS THE HTML
// -----------------------------------------------
// Basic auth is the only scheme a browser implements on its own: answer a
// top-level navigation with 401 + WWW-Authenticate and it shows a native
// username/password prompt, then replays the Authorization header on every
// later same-origin request — including the app's fetch() calls — with no
// client-side code at all. That is why the gate sits in front of the HTML and
// the module graph too, not just /api: fetch() never raises a credential
// prompt, so gating only /api would leave the browser un-challenged and the app
// would simply break instead of asking for the password.
//
// WHAT COUNTS AS "LOCAL"
// ----------------------
// Not just a loopback socket. cloudflared runs on this same machine and dials
// http://localhost:5173, so every tunnelled request arrives from 127.0.0.1 — a
// loopback-only test would wave the entire public internet through and protect
// nothing. A request is therefore treated as remote when any of these hold:
//
//   * the peer address is not loopback (someone on the LAN), or
//   * it carries a proxy/tunnel marker (cf-connecting-ip, x-forwarded-for, …),
//     which the local Vite proxy does not add but Cloudflare's edge always
//     does, or
//   * its Host header is not a loopback name — a tunnel hostname reaches us
//     even if a future proxy stops sending the markers above.
//
// Only a request that fails all three is local and skips the password. Plain
// `http://localhost:5173` development is untouched.
//
// OTHER DELIBERATE CHOICES
// ------------------------
//   * No password configured (the normal case) makes the gate a literal
//     pass-through — nothing to break when no tunnel is in use.
//   * The password is compared with timingSafeEqual over SHA-256 digests, so
//     the buffers are always the same length and the comparison leaks neither
//     the password's length nor how far a guess matched.
//   * Any username is accepted; only the password is the secret. There is one
//     user here, and browsers make you type something into the name box.
//   * Zero dependencies: this module is imported by vite.config.ts as well as
//     by the Express backend, and Vite loads its config outside the app's
//     module graph.
//   * The password is read from process.env, falling back to parsing the
//     project's .env by hand. Vite's envDir is 'src', so the root .env is
//     deliberately never loaded into the Vite process — but the gate still has
//     to see the same value the backend does.
//   * Websocket upgrades (Vite's HMR socket) bypass connect middleware and so
//     bypass this gate. Browsers cannot attach Basic credentials to a websocket
//     handshake anyway, and that socket carries reload notices, never account
//     data.
//   * This is a *transport* gate, not an authorization model. It says "you are
//     the person who ran `npm run tunnel`", nothing more — which is why
//     /api/plaid/credentials and /api/plaid/redirect-uri keep their separate
//     loopback-only guards even for a caller who knows the password.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The project's .env. server/ is one level down, so the root is its parent —
 *  the same import.meta.url derivation server/env-file.js uses, never cwd. */
export const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

/** The one variable that turns the gate on. */
export const PASSWORD_VAR = 'FINCH_TUNNEL_PASSWORD';

// --- Is this request local? --------------------------------------------------

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Is `address` this machine talking to itself?
 *
 * Takes a peer address (req.socket.remoteAddress), not a hostname. Link-local
 * IPv6 arrives with a zone id ('::1%lo0'), which is stripped; the IPv4-mapped
 * spelling is listed outright. Everything else is false — notably a string that
 * merely starts with a loopback literal, like '127.0.0.1.evil.com'.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  return LOOPBACK_ADDRESSES.has(address.split('%')[0].toLowerCase());
}

/**
 * Headers that only appear when something forwarded this request. Cloudflare's
 * edge sets cf-connecting-ip / cf-ray / x-forwarded-for on everything it sends
 * down a quick tunnel; Vite's own /api proxy sets none of them (http-proxy adds
 * x-forwarded-* only with `xfwd: true`, which vite.config.ts does not use), so
 * checking for them costs the normal localhost path nothing.
 */
const FORWARD_MARKERS = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cf-ipcountry',
  'forwarded',
  'true-client-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
];

/** Did this request pass through a proxy or tunnel on its way here? */
export function looksForwarded(headers) {
  if (!headers) return false;
  return FORWARD_MARKERS.some((name) => {
    const value = headers[name];
    return typeof value === 'string' ? value !== '' : Array.isArray(value) && value.length > 0;
  });
}

/** Host header values that mean "you typed this on the machine itself". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '[::]']);

/**
 * Is the Host header a loopback name? A tunnel hostname (xyz.trycloudflare.com)
 * is not, which catches a forwarder that strips the markers above.
 * A missing Host proves nothing either way, so it counts as local.
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host.trim() === '') return true;

  let name = host.trim().toLowerCase();
  if (name.startsWith('[')) {
    // '[::1]:5173' — the port is whatever follows the bracket.
    const end = name.indexOf(']');
    if (end !== -1) name = name.slice(0, end + 1);
  } else {
    const colon = name.indexOf(':');
    if (colon !== -1) name = name.slice(0, colon);
  }

  // '*.localhost' is reserved for loopback by RFC 6761.
  return LOOPBACK_HOSTS.has(name) || name.endsWith('.localhost');
}

/**
 * True only when the request came from this machine, unforwarded, addressed to
 * a loopback name. Anything else is treated as remote and needs the password.
 */
export function isLocalRequest(req) {
  return (
    isLoopbackAddress(req?.socket?.remoteAddress) &&
    !looksForwarded(req?.headers) &&
    isLoopbackHost(req?.headers?.host)
  );
}

// --- The password ------------------------------------------------------------

/** Trimmed, or '' for anything that isn't a usable string. */
function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** `KEY=value` for our one key, allowing indentation and dotenv's `export` form. */
const PASSWORD_LINE = new RegExp(`^\\s*(?:export\\s+)?${PASSWORD_VAR}\\s*=(.*)$`);

/** Strip dotenv-style quoting and trailing ` # comment` from a raw .env value. */
function unquote(rawValue) {
  const value = rawValue.trim();
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(value);
  if (quoted) return quoted[2];
  return value.split(/\s+#/)[0].trim();
}

/**
 * The tunnel password, or '' when none is set (which disables the gate).
 *
 * process.env wins — that is where dotenv puts it for the backend, and where
 * `FINCH_TUNNEL_PASSWORD=… npm run dev` puts it for a one-off. Otherwise the
 * project's .env is parsed directly, because the Vite process never loads it
 * (envDir is 'src'). Only this one key is read; nothing else in .env is
 * touched, and the value is never logged.
 */
export function readTunnelPassword(path = ENV_PATH) {
  const fromProcess = clean(process.env[PASSWORD_VAR]);
  if (fromProcess) return fromProcess;

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return '';
  }

  // Last assignment wins, which is how dotenv resolves a duplicated key.
  let found = '';
  for (const line of raw.split(/\r?\n/)) {
    const match = PASSWORD_LINE.exec(line);
    if (match) found = clean(unquote(match[1]));
  }
  return found;
}

// --- Generating one ----------------------------------------------------------

/**
 * Short, lowercase, unambiguous words. Four of them, drawn independently with
 * crypto.randomInt, is log2(1558^4) ≈ 42 bits — far past guessing range for a
 * URL that lives for one session, and still typeable from a phone keyboard,
 * which matters because linking a bank often means finishing on the phone.
 */
const WORDS = Object.freeze(
  `
  able acid acorn actor adobe agate agent album alder alert algae alley alloy almond aloe
  alpha amber amble amend amigo ample anchor angel angle ankle anvil apex apple apron arbor
  arcade arch arena argon arise armor army aroma arrow ashen aspen aster atlas atom attic
  auburn audio autumn awake award axis azure baby badge bagel baker balsa bamboo banana band
  banjo barge barley barn basil basin basket baton beach beacon bead beam bean bear beaver
  beech beetle bell belt bench berry birch bird bison black blade blank blaze blend bliss
  block bloom blue bluff blush board boat bold bolt bonus book boot bounce bowl brace braid
  brain brake branch brass brave bread brick bridge brief bright brisk broad brook broom brown
  brush bubble bucket buddy bugle build bulb bulk bunch bundle bunny burst bush butter button
  cabin cable cactus cadet camel canal candle candy canoe canvas canyon caper carbon cargo
  carol carrot carve cask castle cave cedar celery cement cereal chair chalk champ chance
  change chant chaos charm chart chase cheek cheer cheese chef cherry chess chest chick chief
  chili chill chime chirp chive choir chord chorus chrome chunk cider cinder circle circus
  citrus civic clamp clash clasp class claw clean clear clerk clever cliff climb cloak clock
  close cloth cloud clove clover clown club clue clump coach coal coast coat cobalt cobra
  cocoa coffee coil coin collar colt comb comet comic comma cone copper coral cork corner
  cosmic cotton couch count court cove cover coyote crab crane crash crate crawl crayon cream
  creek crest crisp crop cross crowd crown cruise crumb crush crust cube cuff curb curl curve
  cycle cymbal dagger dahlia daily dairy daisy dance dandy dart data dawn debut decal deck
  decor deep deer delay delta denim dense depot derby desert design desk detail dial diary
  dice diesel digit dime diner dingo dinner direct disco dish disk ditch dive dock dodge dome
  donkey donut door dose double dough dove dozen draft dragon drape dream dress drift drill
  drink drive drove drum duck duct duel duet dune dusk dust duty dwarf eagle early earth easel
  east echo edge eight elbow elder elect elite ember emblem empire enamel energy engine enjoy
  enter entry envoy epic equal equip erase error escape essay ether ethic event exact expert
  extra fable fade fairy faith falcon fancy fang farm fauna fawn feast fence fern ferry fever
  fiber field fight file filter final finch finger fire firm flag flake flame flare flash
  flask flax fleet flint float flock flood floor flour flower fluid flute foam focus foil fold
  folk font force forest forge fork form fort forum fossil frame fresh friend fringe frog
  front frost froth fruit fudge fuel funnel fuse future gable gadget gala galaxy gale gallon
  garage garden garlic gauge gavel gaze gecko gentle geyser giant gift ginger glade glance
  glass glaze gleam glide glint globe gloom glory glove glow gnome goat gold golf goose gorge
  gown grace grade grain grand grant grape graph grasp grass grate grave gravy graze green
  greet grid grill grin grip grit groom grove growl guard guess guest guide guild gulf gull
  gulp gust habit hail half hall halo hammer handle happy harbor hare harp hasty hatch haven
  hawk haze hazel heap heart heath heavy hedge heel helix hello helm hemp herb herd hero
  hidden hike hill hinge hint hive hobby hockey holly home honey honor hoof hook hoop horn
  horse hose hotel hound hour house human humble hurdle hurry husk hydra hymn icicle icon idea
  idle igloo image inch index indigo infant inlet insect inside invite iris iron island isle
  issue item ivory jacket jade jaunt jazz jeans jelly jewel jolly jolt judge juice jumbo
  jungle junior junk jury jute kale kayak keel keen kelp kennel kettle kiosk kite kitten kiwi
  knack knee knife knight knit knob knock knot koala label labor lace ladder lagoon lamb lance
  lapel larch large lark laser lasso latch latte laugh launch laurel lava lawn layer lazy leaf
  leap learn lease leash ledge leek legacy legend lemon lens lentil level lever light lilac
  lily lime limit linen link lion liter little lizard llama loaf lobby local locust lodge
  logic loop loose lotus lounge loyal lumber lunar lunch lute luxury lynx lyric macaw magic
  magnet magpie maize major mallet mammal mango manor mantle manual maple marble march margin
  marina market marsh mask mason match matrix matter maze meadow medal media medium melody
  melon memo menu mercy merit merry mesa mesh metal meteor meter method might mild mile milk
  mill mimic minor mint mirror mist mitten moat mocha model modem modern modest moist mold
  mole monkey month moon moose moral mortar mosaic moss moth mother motion motor mound mount
  mouse mouth movie muffin mule mural muse museum music mussel myrtle myth nacho napkin narrow
  nation native nature navy neat nectar needle neon nerve nest nettle newt niche nickel night
  nimble noble node noise nomad noodle north nose note notice noun novel novice nudge number
  nurse nutmeg nylon oasis ocean octave offer office often ogre olive omega onion onset onyx
  opal opera orange orbit orchid order organ origin otter ounce outer oval oven owner oxide
  oyster ozone pace paddle pail paint palace palm panda panel pansy paper parade parcel parent
  parrot party pasta patch path patio pause pearl pebble pecan pedal pelt pencil penny people
  pepper perch period permit petal phase phone photo piano picnic piece pier pigeon pike pilot
  pinch pine pint pipe pirate pitch pivot pixel pizza place plain plank plant plasma plate
  plaza pledge plot plow pluck plum plume pocket poem poet point polar polish pollen pond pony
  pool poplar poppy porch portal post potato pouch pound powder power praise prawn press price
  pride prime print prism prize probe prompt proof proud prove prune public puddle puffin
  pulse pump punch pupil puppy purple purse puzzle quail quaint quake quart quartz queen query
  quest quick quiet quill quilt quirk quiver quota quote rabbit race rack radar radio radish
  raft rail rain raise rake rally ramp ranch range rapid raven razor reach realm reason rebel
  recess record reed reef refine region relax relay relic remedy remote repair reply report
  rescue resin resort result return review reward rhino rhythm ribbon ridge rifle rigid rinse
  ripe ripple risk ritual river roast robe robin robot rocket rodeo rogue roof room roost rope
  rose rotate rough round route rover royal rubber ruby rudder rugby ruler rumble rune rural
  rust rustic saddle safe sage sail saint salad salmon salon salsa sample sandal sash satin
  sauce sauna savor scale scarf scene scent school scone scoop scope score scout scrap screen
  screw script scroll scrub seal seam search season secret sector seed seize senate senior
  sense sepia serve sesame settle seven shade shadow shaft shake shale shape share shark sharp
  shave shawl sheep sheet shelf shell shield shift shine ship shirt shock shore short shout
  shovel shrub sight signal silent silk silly silver simple single siren sister skate sketch
  skill skirt skull slate sled sleek sleep sleet slice slide slim slope slot small smart smell
  smile smoke snack snail snake snap sneak snow soap soar sober social soda sofa soil solar
  solid solo solve song sorbet soul sound soup south space spade spare spark speak spear
  speech speed spell sphere spice spider spike spine spiral spirit splash split spoke sponge
  spool spoon sport spout spray spread spring sprout spruce square squash stack staff stage
  stair stake stall stamp stand stark start state steam steel steep stem stereo stick stiff
  still sting stitch stock stone stool store storm story stove strand straw streak stream
  street stress strike string stripe strong studio study stump style sugar summer summit sunny
  sunset super supper supply surf surge survey swan swarm sweep sweet swell swift swing switch
  sword symbol syrup system table tackle tailor talent talon tandem tangle tank tape target
  tarp tart task taste tavern taxi teach teak team tease teeth temple tempo tender tennis tent
  term thank thaw theme thick thing think third thorn three thrill throat throne thumb thyme
  ticket tidy tiger tight tile tilt timber tiny title toad toast today tofu token tomato tone
  tongue tonic tool tooth topaz topic torch total totem touch tough tour towel tower toy trace
  track trade trail train trait tram trap travel tray treat tree trek trend trial tribe trick
  trim trio trip trophy trout truck trunk trust truth tube tulip tumble tuna tundra tunnel
  turbo turf turkey turtle tusk tutor tweed twelve twig twin twist type ultra uncle under
  unfold union unique unit unite unity update upper upset urban urge usage useful usher utmost
  vacant vague valid valley value valve vane vapor vase vast vault veer veil vein velvet
  vendor venue verb verse vessel vest veto vibe video villa vine vinyl viola violet viper
  virtue vision visit visor vista vital vivid vocal voice volume voter vowel voyage wade wafer
  wagon waist wake walk wall walnut walrus waltz wand wander warden warm wash wasp watch water
  wave wedge weed week weigh weird well west whale wharf wheat wheel whim whirl whisk white
  whole wick wide widow width wild willow wind window wine wing wink winter wipe wire wise
  wish wisp witty wizard wolf wonder wood wool word work world worm worry worth wound woven
  wrap wren wrist write xenon yacht yard yarn yawn year yeast yellow yield yodel yoga yogurt
  yolk young youth yucca zebra zenith zero zest zigzag zinc zipper zone zoom
`
    .split(/\s+/)
    .filter(Boolean),
);

/** How many bits a generated password is worth, for anyone doing the maths. */
export const PASSWORD_BITS = Math.round(4 * Math.log2(WORDS.length));

/** A fresh password, e.g. 'amber-otter-lamp-quiet'. Four words, hyphenated. */
export function generatePassword(wordCount = 4) {
  const picked = [];
  for (let i = 0; i < wordCount; i += 1) picked.push(WORDS[randomInt(WORDS.length)]);
  return picked.join('-');
}

// --- Checking one ------------------------------------------------------------

/**
 * Constant-time string equality.
 *
 * timingSafeEqual throws unless both buffers are the same length, and the
 * lengths themselves leak — so hash both sides first: two SHA-256 digests are
 * always 32 bytes, whatever was typed.
 */
function sameSecret(a, b) {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** Standard base64 only — what every browser sends for `Basic`. */
const BASIC_HEADER = /^\s*Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i;

/**
 * Does an Authorization header carry the right password?
 *
 * Accepts any username: there is one user here and the password is the secret.
 * Returns false for an absent, malformed, or non-Basic header, and for an empty
 * configured password — "no password set" is never something to authenticate
 * against, it is handled by makeGate() letting everything through.
 */
export function checkBasicAuth(headerValue, password) {
  if (typeof password !== 'string' || password === '') return false;
  if (typeof headerValue !== 'string') return false;

  const match = BASIC_HEADER.exec(headerValue);
  if (!match) return false;

  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return false;
  }

  // `user:pass`; a password may itself contain colons, a username may not.
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;

  return sameSecret(decoded.slice(separator + 1), password);
}

// --- Refusing --------------------------------------------------------------

/** Quotes and control characters would break out of the realm's own quoting. */
function safeRealm(realm) {
  const cleaned = String(realm ?? '').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '');
  return cleaned || 'Finch';
}

const CHALLENGE_BODY = [
  "Finch needs a password because you're reaching it over a tunnel, not from the",
  'computer it runs on.',
  '',
  'The password is the one `npm run tunnel` printed when it opened the tunnel.',
  'Any username works.',
  '',
  'If you did not open this tunnel, close this page — it fronts somebody',
  "else's bank data.",
  '',
].join('\n');

/**
 * Answer 401 with the challenge that makes a browser prompt.
 *
 * Written with the node:http API rather than Express helpers, because the same
 * function serves Vite's connect middleware stack, where `res` is a bare
 * ServerResponse with no .status()/.send().
 */
export function unauthorized(res, realm = 'Finch') {
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', `Basic realm="${safeRealm(realm)}", charset="UTF-8"`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(CHALLENGE_BODY)));
  // A cached 401 would be a confusing thing to serve after the password changes.
  res.setHeader('Cache-Control', 'no-store');
  res.end(CHALLENGE_BODY);
}

// --- The gate ----------------------------------------------------------------

/**
 * A connect/Express middleware that demands the tunnel password from anyone who
 * isn't sitting at this machine.
 *
 * With no password configured it is a pass-through — plain localhost
 * development must not notice this file exists. With one, local requests still
 * go straight through (so the Vite proxy's own hop to the backend never
 * double-prompts) and everything else has to present it.
 */
export function makeGate({ password = '', realm = 'Finch' } = {}) {
  const secret = clean(password);

  // Nothing to enforce: hand back the cheapest possible middleware.
  if (!secret) return (_req, _res, next) => next();

  return function tunnelGate(req, res, next) {
    if (isLocalRequest(req)) return next();
    if (checkBasicAuth(req?.headers?.authorization, secret)) return next();
    return unauthorized(res, realm);
  };
}
