// 'three' resolves via the <script type="importmap"> in index.html - the
// examples/jsm addons below import from the bare specifier internally, so
// the core module has to be reachable the same way rather than a direct URL.
import * as THREE from 'three';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/controls/OrbitControls.js';
import { quaternionToEulerDegrees } from './orientation-math.js';

export { quaternionToEulerDegrees };

const MODEL_URL = 'assets/Drone.gltf';

// The Onshape export's own root orientation doesn't line up with our body
// frame: as exported, the model stands on end with its long axis along Z
// (confirmed by rendering it raw with no correction at all - a Z-only
// rotation can't fix that, it only spins around the vertical axis and the
// model stays standing). Rotating about Y lays it flat, nose along X -
// matching ROTATION_BODY_TO_THREE below, which puts the roll axis on X.
const MODEL_CORRECTION_Y = -Math.PI / 2;

// Vehicle body frame (confirmed with the user): X = forward/aft, Y = left,
// Z = up ("FLU" - a common robotics convention; forward x left = up keeps it
// right-handed). Used for velocity/acceleration vectors, which the firmware
// already reports in a Z-up world/gravity reference frame independent of
// body axes - so this stays a straight identity passthrough to Three's Z-up
// display.
const BODY_TO_THREE = new THREE.Matrix4().identity();

// The *rotation* (attitude quaternion) needs a different mapping than plain
// vectors: the user confirmed the wire's K/Z component is this vehicle's
// roll axis (nose-to-tail), not the up axis the plain identity mapping
// above would imply - so X and Z swap roles here specifically for rotation.
// A bare swap of two axes is a reflection (determinant -1, mirrors
// handedness), so X also gets negated to keep this a proper rotation;
// Y (left) is untouched to preserve the confirmed "Y right of X" display
// convention. Sign of the negation is a best guess pending live
// confirmation - flip it if rotations come out mirrored/backwards.
const ROTATION_BODY_TO_THREE = new THREE.Matrix4().set(
  0, 0, -1, 0,
  0, 1, 0, 0,
  1, 0, 0, 0,
  0, 0, 0, 1,
);
const ROTATION_BODY_TO_THREE_INVERSE = ROTATION_BODY_TO_THREE.clone().invert();

const VECTOR_SCALE = 0.35; // scene units per (m/s or m/s^2)
const VECTOR_MIN_LENGTH = 0.05;
const VECTOR_MAX_LENGTH = 3;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function bodyQuaternionToThree(qR, qI, qJ, qK) {
  const bodyMatrix = new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion(qI, qJ, qK, qR),
  );
  const threeMatrix = ROTATION_BODY_TO_THREE.clone()
    .multiply(bodyMatrix)
    .multiply(ROTATION_BODY_TO_THREE_INVERSE);
  return new THREE.Quaternion().setFromRotationMatrix(threeMatrix);
}

function bodyVectorToThree(x, y, z) {
  return new THREE.Vector3(x, y, z).applyMatrix4(BODY_TO_THREE);
}

// Body-forward (+X) maps straight to three(+X) at rest (see MODEL_CORRECTION_Y
// above), so the placeholder's long axis runs along three's X, nose at +X -
// aligned with the roll axis so a roll rotation spins it in place.
function buildPlaceholder() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.6, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x42b8ff, opacity: 0.85, transparent: true }),
  );
  group.add(body);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.4, 4),
    new THREE.MeshStandardMaterial({ color: 0xffbe55 }),
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 1;
  group.add(nose);

  return group;
}

// Text sprite for one axis label - a small canvas-drawn glyph rendered as a
// billboarded THREE.Sprite, so it always faces the camera regardless of
// OrbitControls rotation.
function createAxisLabelSprite(text, color) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.28, 0.28, 1);
  sprite.renderOrder = 1;
  return sprite;
}

// Matches THREE.AxesHelper's own red/green/blue X/Y/Z convention.
function buildAxesLabels(length) {
  const group = new THREE.Group();

  const labelX = createAxisLabelSprite('X', '#ff5555');
  labelX.position.set(length, 0, 0);

  const labelY = createAxisLabelSprite('Y', '#55ff55');
  labelY.position.set(0, length, 0);

  const labelZ = createAxisLabelSprite('Z', '#5599ff');
  labelZ.position.set(0, 0, length);

  group.add(labelX, labelY, labelZ);
  return group;
}

function fitAndCenter(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const largestDimension = Math.max(size.x, size.y, size.z) || 1;

  object3d.position.sub(center);

  const wrapper = new THREE.Group();
  const targetSize = 2;
  const scale = targetSize / largestDimension;
  wrapper.scale.setScalar(scale);
  wrapper.add(object3d);
  return wrapper;
}

export function createOrientationView(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1018);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  camera.up.set(0, 0, 1);
  camera.position.set(3.2, -3.2, 2.6);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0.3);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(4, -4, 6);
  scene.add(sun);

  // GridHelper is built flat in the XZ plane by default - rotate it into the
  // XY plane so it reads as the "ground" now that Z is up.
  const grid = new THREE.GridHelper(10, 20, 0x2a394b, 0x1a2430);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  const axesLength = 1.6;
  scene.add(new THREE.AxesHelper(axesLength));
  scene.add(buildAxesLabels(axesLength + 0.22));

  const vehicleGroup = new THREE.Group();
  vehicleGroup.position.set(0, 0, 0.5);
  scene.add(vehicleGroup);

  let currentModel = buildPlaceholder();
  vehicleGroup.add(currentModel);

  const velocityArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0.5), VECTOR_MIN_LENGTH, 0x42b8ff, 0.12, 0.08,
  );
  const accelArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0.5), VECTOR_MIN_LENGTH, 0xffbe55, 0.12, 0.08,
  );
  velocityArrow.visible = false;
  accelArrow.visible = false;
  scene.add(velocityArrow, accelArrow);

  const state = {
    loading: false,
    loaded: false,
    loadError: null,
    loadProgress: 0,
    velocityMagnitude: 0,
    accelMagnitude: 0,
  };

  function setArrow(arrow, x, y, z) {
    const magnitude = Math.hypot(x, y, z);
    if (magnitude < 1e-4) {
      arrow.visible = false;
      return 0;
    }
    arrow.visible = true;
    const threeVec = bodyVectorToThree(x, y, z).normalize();
    arrow.setDirection(threeVec);
    arrow.setLength(clamp(magnitude * VECTOR_SCALE, VECTOR_MIN_LENGTH, VECTOR_MAX_LENGTH), 0.12, 0.08);
    return magnitude;
  }

  function updateOrientation(qR, qI, qJ, qK) {
    if (![qR, qI, qJ, qK].every(Number.isFinite)) return;
    vehicleGroup.quaternion.copy(bodyQuaternionToThree(qR, qI, qJ, qK));
  }

  // Velocity and acceleration arrive as independent telemetry fragments in
  // relay mode (STATUS4/STATUS5 land in separate packets), so these update
  // independently rather than requiring both every call.
  function updateVelocity(x, y, z) {
    if (![x, y, z].every(Number.isFinite)) return;
    state.velocityMagnitude = setArrow(velocityArrow, x, y, z);
  }

  function updateAcceleration(x, y, z) {
    if (![x, y, z].every(Number.isFinite)) return;
    state.accelMagnitude = setArrow(accelArrow, x, y, z);
  }

  function loadModel(url = MODEL_URL) {
    state.loading = true;
    state.loadError = null;
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        vehicleGroup.remove(currentModel);
        gltf.scene.rotateY(MODEL_CORRECTION_Y);
        currentModel = fitAndCenter(gltf.scene);
        vehicleGroup.add(currentModel);
        state.loading = false;
        state.loaded = true;
      },
      (event) => {
        if (event.total) state.loadProgress = event.loaded / event.total;
      },
      (error) => {
        state.loading = false;
        state.loadError = error?.message || 'Failed to load 3D model';
        // Placeholder box stays in place - not a hard failure.
      },
    );
  }

  function resize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  let animating = true;
  function animate() {
    if (!animating) return;
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }

  function dispose() {
    animating = false;
    controls.dispose();
    renderer.dispose();
  }

  resize();
  animate();

  return {
    state,
    loadModel,
    updateOrientation,
    updateVelocity,
    updateAcceleration,
    resize,
    dispose,
  };
}
