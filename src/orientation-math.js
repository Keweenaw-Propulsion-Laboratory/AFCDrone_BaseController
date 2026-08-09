// Pure math shared by orientation-view.js and its tests. No Three.js (or any
// other) dependency, deliberately - orientation-view.js pulls Three.js from
// a CDN via top-level imports, which plain Node can't resolve, so anything
// that needs to run under `node tests/protocol.test.mjs` has to live here
// instead.

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Same formulas as the firmware's Gyro::quaternionToEuler, operating on the
 * body-frame quaternion directly (not any Three.js-remapped one), but with
 * roll and yaw swapped from the firmware's own labeling (confirmed with the
 * user): this vehicle's roll axis is Z (up), not X (forward), so rotation
 * about K (Z) is reported as roll and rotation about I (X) as yaw. Pitch
 * (about J/Y) is unchanged.
 */
export function quaternionToEulerDegrees(qR, qI, qJ, qK) {
  const sqr = qR * qR;
  const sqi = qI * qI;
  const sqj = qJ * qJ;
  const sqk = qK * qK;

  const roll = Math.atan2(2 * (qI * qJ + qK * qR), sqi - sqj - sqk + sqr);
  const pitch = Math.asin(clamp(-2 * (qI * qK - qJ * qR) / (sqi + sqj + sqk + sqr), -1, 1));
  const yaw = Math.atan2(2 * (qJ * qK + qI * qR), -sqi - sqj + sqk + sqr);

  const toDeg = 180 / Math.PI;
  return { yaw: yaw * toDeg, pitch: pitch * toDeg, roll: roll * toDeg };
}
