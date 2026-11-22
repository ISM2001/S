/** Deterministic PRNG so the seed produces the same data every time. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FAKE NUMBERS ONLY. Seed data uses these documented blocks:
 *   06 00 0x xx xx  (demo dataset: 0600000000–0600099999)
 *   07 xx xx xx xx starting at 0700000000 (load-test dataset)
 * Morocco has no officially reserved "fiction" range. These blocks are used ONLY with the
 * development pepper, and the seed refuses to run in production, so a collision with a real
 * subscriber can never leak anything.
 */
export const demoPhone = (i: number) => `+2126000${String(i).padStart(5, "0")}`;
export const loadPhone = (i: number) => `+2127${String(i).padStart(8, "0")}`;

export function assertNotProduction() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed: NODE_ENV=production");
    process.exit(1);
  }
  const pepper = process.env.PHONE_HASH_PEPPER ?? "";
  if (pepper.length < 32) {
    console.error("PHONE_HASH_PEPPER missing or too short. Did you `cp .env.example .env`?");
    process.exit(1);
  }
  return pepper;
}
