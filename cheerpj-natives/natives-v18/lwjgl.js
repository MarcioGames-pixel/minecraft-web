// Load the glMatrix library
await import("https://cdnjs.cloudflare.com/ajax/libs/gl-matrix/3.4.2/gl-matrix-min.js");

const glCanvas = window.lwjglCanvasElement;
if (!(glCanvas instanceof HTMLCanvasElement)) throw new Error("window.lwjglCanvasElement is not set or is not a canvas");
const glCtx = glCanvas.getContext("webgl2", {antialias: false, alpha: false});
// Resolucao logica do jogo = tamanho do canvas (definido pelo index.html antes de iniciar)
const FBW = glCanvas.width, FBH = glCanvas.height;

var vertexShaderSrc = `
	attribute vec4 aVertexPosition;
	attribute vec4 aColor;
	attribute vec2 aTexCoord;
	uniform mat4 modelView;
	uniform mat4 projection;
	varying vec2 vTexCoord;
	varying vec4 vColor;
	void main() {
		gl_Position = projection * modelView * aVertexPosition;
		vTexCoord = aTexCoord;
		vColor = aColor;
	}
`;
// NOTE: Only the default GL_MODULATE texEnv is supported here
var fragmentShaderSrc = `
	precision mediump float;
	uniform float uTextureMask;
	uniform sampler2D uSampler;
	uniform sampler2D uSampler2; // Additional texture sampler
	varying vec2 vTexCoord;
	varying vec4 vColor;
	void main() {
		vec4 texSample = texture2D(uSampler, vTexCoord) * uTextureMask;
		vec4 texSample2 = texture2D(uSampler2, vTexCoord);
		vec4 colorValue = vColor;
		gl_FragColor = mix(texSample, colorValue, texSample2);
	}
`;
var vertexShader = glCtx.createShader(glCtx.VERTEX_SHADER);
glCtx.shaderSource(vertexShader, vertexShaderSrc);
glCtx.compileShader(vertexShader);
var fragmentShader = glCtx.createShader(glCtx.FRAGMENT_SHADER);
glCtx.shaderSource(fragmentShader, fragmentShaderSrc);
glCtx.compileShader(fragmentShader);
var program = glCtx.createProgram();
glCtx.attachShader(program, vertexShader);
glCtx.attachShader(program, fragmentShader);
glCtx.linkProgram(program);
glCtx.useProgram(program);
var vertexBuffer = glCtx.createBuffer();
var colorBuffer = glCtx.createBuffer();
var texCoordBuffer = glCtx.createBuffer();
var vertexPosition = glCtx.getAttribLocation(program, "aVertexPosition");
var colorLocation = glCtx.getAttribLocation(program, "aColor");
var texCoord = glCtx.getAttribLocation(program, "aTexCoord");
var mvLocation = glCtx.getUniformLocation(program, "modelView");
var projLocation = glCtx.getUniformLocation(program, "projection");
var samplerLocation = glCtx.getUniformLocation(program, "uSampler");
var samplerLocation2 = glCtx.getUniformLocation(program, "uSampler2");
var texMaskLocation = glCtx.getUniformLocation(program, "uTextureMask");
var vertexData =
{
	enabled: false,
	size: 0,
	type: 0,
	stride: 0,
	pointer: 0,
	buf: null
};
var normalData =
{
	enabled: false,
	size: 0,
	type: 0,
	stride: 0,
	pointer: 0,
	buf: null
};
var colorData =
{
	enabled: false,
	size: 0,
	type: 0,
	stride: 0,
	pointer: 0,
	buf: null
};
var texCoordData =
{
	enabled: false,
	size: 0,
	type: 0,
	stride: 0,
	pointer: 0,
	buf: null
};
// TODO: Make buffers resizeable if needed
var immediateModeData =
{
	mode: 0,
	vertexBuf: new Float32Array(32),
	vertexPos: 0,
	texCoordBuf: new Float32Array(32),
	texCoordPos: 0
};
var verboseLog = false;
var frameCount = 0;
// Set to a non-zero value to stop after a certain number of frames
var frameLimit = 0;
// NOTE: These initializes to identity
var projMatrixStack = [glMatrix.mat4.create()];
var modelViewMatrixStack = [glMatrix.mat4.create()];
var textureMatrixStack = [glMatrix.mat4.create()];
var curMatrixStack = modelViewMatrixStack;
function getCurMatrixTop()
{
	return curMatrixStack[curMatrixStack.length - 1];
}
function setCurMatrixTop(m)
{
	curMatrixStack[curMatrixStack.length - 1] = m;
}
function uploadDataImpl(buf, buffer, attributeLocation, size, type, stride)
{
	glCtx.bindBuffer(glCtx.ARRAY_BUFFER, buffer);
	glCtx.bufferData(glCtx.ARRAY_BUFFER, buf, glCtx.STATIC_DRAW);
	glCtx.vertexAttribPointer(attributeLocation, size, type, type != glCtx.FLOAT, stride, 0);
	glCtx.enableVertexAttribArray(attributeLocation);
}
function uploadData(v, data, buffer, attributeLocation, count)
{
	if(data.enabled)
	{
		assert(data.stride);
		var buf = data.buf;
		if(buf == null)
		{
			assert(v && data.pointer);
			buf = new Uint8Array(v.buffer, data.pointer, data.stride * count);
		}
		uploadDataImpl(buf, buffer, attributeLocation, data.size, data.type, data.stride);
	}
	else
	{
		glCtx.disableVertexAttribArray(attributeLocation);
	}
}
function captureData(v, data, count)
{
	var ret = { enabled: data.enabled, size: data.size, type: data.type, stride: data.stride, pointer: 0, buf: null };
	if(data.enabled)
	{
		assert(data.stride);
		var buf = new Uint8Array(v.buffer, data.pointer, data.stride * count);
		// Capture the current data
		ret.buf = new Uint8Array(buf);
	}
	return ret;
}
function checkNoList(list)
{
	if(list != null)
		throw new Error("Unsupported command in list");
}
function pushInList(list, args, callee)
{
	// Not an elegant solution, but it works
	// It would be nicer to extract the actual implementation from native interfaces
	// to avoid bringing around the library object
	list.push({f: callee, a: Array.from(args)});
}
function callList(listId)
{
	var l = cmdLists[listId];
	for(var i=0;i<l.length;i++)
	{
		var c = l[i];
		c.f.apply(null, c.a);
	}
}
function drawArraysImpl(mode, first, count)
{
	// TODO: Conditional
	glCtx.uniformMatrix4fv(mvLocation, false, modelViewMatrixStack[modelViewMatrixStack.length - 1]);
	glCtx.uniformMatrix4fv(projLocation, false, projMatrixStack[projMatrixStack.length - 1]);
	assert(first == 0);
	// We can render each quad a separate GL_TRIANGLE_FAN
	if(mode == 7/*QUADS*/ && (count % 4) == 0)
	{
		for(var i=0;i<count;i+=4)
			glCtx.drawArrays(glCtx.TRIANGLE_FAN, i, 4);
	}
	else if(mode == glCtx.LINES || mode == glCtx.LINE_STRIP || mode == glCtx.TRIANGLE_STRIP || mode == glCtx.TRIANGLE_FAN)
	{
		glCtx.drawArrays(mode, first, count);
	}
	else
	{
		debugger;
	}
}
function pushDrawArraysInList(list, v, mode, first, count)
{
	var args = [mode, first, count, captureData(v, vertexData, count), captureData(v, colorData, count), captureData(v, texCoordData, count)];
	list.push({f: drawArraysInList, a: args});
}
function drawArraysInList(mode, first, count, capturedVertexData, capturedColorData, capturedTexCoordData)
{
	// Upload vertex data
	uploadData(null, capturedVertexData, vertexBuffer, vertexPosition, count);
	// Upload color data
	uploadData(null, capturedColorData, colorBuffer, colorLocation, count);
	// Upload tex coord data
	uploadData(null, capturedTexCoordData, texCoordBuffer, texCoord, count);
	drawArraysImpl(mode, first, count);
}
// Fix the sampler to texture unit 0
glCtx.uniform1i(samplerLocation, 0);
var curList = null;
var cmdLists = [null];
// The first null implicitly solves resetting on 0 id
var textureObjects = [null];
// We need to use an FBO as the main target to support copyTexSubImage2D that seems broken otherwise
var fbTexture = glCtx.createTexture();
glCtx.bindTexture(glCtx.TEXTURE_2D, fbTexture);
glCtx.texImage2D(glCtx.TEXTURE_2D, 0, glCtx.RGBA, FBW, FBH, 0, glCtx.RGBA, glCtx.UNSIGNED_BYTE, null);
glCtx.bindTexture(glCtx.TEXTURE_2D, null);
var mainFb = glCtx.createFramebuffer();
glCtx.bindFramebuffer(glCtx.READ_FRAMEBUFFER, mainFb);
glCtx.bindFramebuffer(glCtx.DRAW_FRAMEBUFFER, mainFb);
glCtx.framebufferTexture2D(glCtx.FRAMEBUFFER, glCtx.COLOR_ATTACHMENT0, glCtx.TEXTURE_2D, fbTexture, 0);
// Add a depth render buffer
var depthRb = glCtx.createRenderbuffer();
glCtx.bindRenderbuffer(glCtx.RENDERBUFFER, depthRb);
glCtx.renderbufferStorage(glCtx.RENDERBUFFER, glCtx.DEPTH_COMPONENT16, FBW, FBH);
glCtx.framebufferRenderbuffer(glCtx.FRAMEBUFFER, glCtx.DEPTH_ATTACHMENT, glCtx.RENDERBUFFER, depthRb);
// Synthetize a focus event, it's needed for LWJGL logic
var eventQueue = [{type:"focus"}];

function convertMousePos(x, y) {
	// We have a framebuffer of 1000x500, but Minecraft renders into the bottom left corner of it.
	const offsetX = 0;
	const offsetY = 0;

	const xRatio = glCanvas.width / glCanvas.clientWidth;
	const yRatio = glCanvas.height / glCanvas.clientHeight;

	return [x * xRatio - offsetX, y * yRatio - offsetY];
}

/** Olhar por toque: o index.html chama window.lwjglLook(dx, dy) ao arrastar o dedo */
window.lwjglLook = function(dx, dy) {
	if (!lockedMousePos) return;
	const x = lockedMousePos.x += dx, y = lockedMousePos.y += dy;
	if (eventQueue[0]?.type == "mousemove") { eventQueue[0].x = x; eventQueue[0].y = y; }
	else eventQueue.push({ type: "mousemove", x, y });
};

/** Convert from MouseEvent.button to X11 mouse button */
function convertMouseButton(button) {
	return button + 1;
}

/**
 * If null, the game does not want the mouse pointer locked.
 * @type {{ x: number, y: number } | null}
 */
let lockedMousePos = null;

glCanvas.addEventListener("mousemove", evt => {
	let [x, y] = convertMousePos(evt.offsetX, evt.offsetY);

	// If the pointer is locked, we can't use offsetX/offsetY
	if (lockedMousePos) {
		x = lockedMousePos.x += evt.movementX;
		y = lockedMousePos.y += evt.movementY;

		if (!document.pointerLockElement) {
			// Game still wants the pointer locked, but it's not
			Java_org_lwjgl_opengl_LinuxDisplay_nGrabPointer();
		}
	}

	if (eventQueue[0]?.type == evt.type) {
		// Update unhandled event
		eventQueue[0].x = x;
		eventQueue[0].y = y;
	} else {
		eventQueue.push({ type: evt.type, x, y });
	}
});
function mouseHandler(evt) {
	const [x, y] = convertMousePos(evt.offsetX, evt.offsetY);
	eventQueue.push({ type: evt.type, x, y, button: convertMouseButton(evt.button) });
}
glCanvas.addEventListener("mousedown", mouseHandler);
glCanvas.addEventListener("mouseup", mouseHandler);
glCanvas.addEventListener("contextmenu", evt => evt.preventDefault());

/** @param {KeyboardEvent} e */
function keyHandler(e)
{
	// Convert to LinuxKeycodes.java keycodes
	// https://github.com/LWJGL/lwjgl/blob/master/src/java/org/lwjgl/opengl/LinuxKeycodes.java
	let keyCode = e.keyCode || e.key.charCodeAt(0); // most map to ASCII
	switch (e.key) {
		case "Escape": // note will have to press twice if pointer is locked
			keyCode = 0xff1b;
			break;
		case "Shift":
			keyCode = 0xffe1;
			break;
		case "Control":
			keyCode = 0xffe3;
			break;
		case "Meta":
			keyCode = 0xffe7;
			break;
		case "Alt":
			keyCode = 0xffe9;
			break;
	}
	console.log(e.key, keyCode);

	eventQueue.push({ type: e.type, keyCode });
	e.preventDefault();
}
glCanvas.addEventListener("keydown", keyHandler);
glCanvas.addEventListener("keyup", keyHandler);
function Java_org_lwjgl_DefaultSysImplementation_getPointerSize()
{
	return 4;
}

function Java_org_lwjgl_DefaultSysImplementation_getJNIVersion()
{
	return 18;
}

function Java_org_lwjgl_DefaultSysImplementation_setDebug()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_nLockAWT()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_nUnlockAWT()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_setErrorHandler()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_openDisplay(lib)
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_nInternAtom()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_nIsXrandrSupported()
{
	return 0;
}

function Java_org_lwjgl_opengl_LinuxDisplay_nIsXF86VidModeSupported()
{
	return 1;
}

function Java_org_lwjgl_opengl_LinuxDisplay_nGetDefaultScreen()
{
	return 0;
}

async function Java_org_lwjgl_opengl_LinuxDisplay_nGetAvailableDisplayModes(lib)
{
	var DisplayMode = await lib.org.lwjgl.opengl.DisplayMode;
	var d = await new DisplayMode(FBW, FBH);
	return [d];
}

function Java_org_lwjgl_opengl_LinuxDisplay_nGetCurrentGammaRamp()
{
}

function Java_org_lwjgl_opengl_LinuxPeerInfo_createHandle()
{
}

function Java_org_lwjgl_opengl_GLContext_nLoadOpenGLLibrary()
{
}

function Java_org_lwjgl_opengl_LinuxDisplayPeerInfo_initDefaultPeerInfo()
{
}

function Java_org_lwjgl_opengl_LinuxDisplayPeerInfo_initDrawable()
{
}

function Java_org_lwjgl_opengl_AWTSurfaceLock_createHandle()
{
}

function Java_org_lwjgl_opengl_AWTSurfaceLock_lockAndInitHandle()
{
	return 1;
}

function Java_org_lwjgl_opengl_LinuxAWTGLCanvasPeerInfo_getScreenFromSurfaceInfo()
{
}

function Java_org_lwjgl_opengl_LinuxAWTGLCanvasPeerInfo_nInitHandle()
{
}

function Java_org_lwjgl_opengl_AWTSurfaceLock_nUnlock()
{
}

function Java_org_lwjgl_opengl_LinuxPeerInfo_nGetDrawable()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_nCreateWindow()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_mapRaised()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_nCreateBlankCursor()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_nSetTitle()
{
}

function Java_org_lwjgl_opengl_LinuxMouse_nGetButtonCount()
{
	return 3;
}

function Java_org_lwjgl_opengl_LinuxMouse_nQueryPointer()
{
}

function Java_org_lwjgl_opengl_LinuxMouse_nGetWindowHeight()
{
	return FBH;
}

function Java_org_lwjgl_opengl_LinuxKeyboard_getModifierMapping()
{
}

function Java_org_lwjgl_opengl_LinuxKeyboard_nSetDetectableKeyRepeat()
{
}

function Java_org_lwjgl_opengl_LinuxKeyboard_openIM()
{
}

function Java_org_lwjgl_opengl_LinuxKeyboard_allocateComposeStatus()
{
}

function Java_org_lwjgl_opengl_LinuxContextImplementation_nCreate()
{
}

function Java_org_lwjgl_opengl_LinuxContextImplementation_nMakeCurrent()
{
}

function Java_org_lwjgl_opengl_LinuxContextImplementation_nIsCurrent()
{
	return true;
}

function Java_org_lwjgl_opengl_GLContext_ngetFunctionAddress(lib, stringPtr)
{
	// Return any non-zero address, methods are called by name anyway
	return 1;
}

function Java_org_lwjgl_opengl_GL11_nglGetString(lib, id, funcPtr)
{
	checkNoList(curList);
	// Special case GL_EXTENSION for now
	if(id == 0x1F03)
	{
		// TODO: Do we need any?
		return "";
	}
	else
	{
		return glCtx.getParameter(id);
	}
}

function Java_org_lwjgl_opengl_GL11_nglGetIntegerv(lib, id, memPtr, funcPtr)
{
	checkNoList(curList);
	var v = lib.getJNIDataView();
	var buf = new Int32Array(v.buffer, Number(memPtr), 4);
	if(id == /*GL_VIEWPORT*/0xba2)
	{
		buf[0] = 0;
		buf[1] = 0;
		buf[2] = FBW;
		buf[3] = FBH;
	}
	else if(verboseLog)
	{
		console.log("glGetInteger", id);
	}
}

function Java_org_lwjgl_opengl_GL11_nglGetError()
{
	checkNoList(curList);
	// We like living dangerously
	return 0;
}

function Java_org_lwjgl_opengl_LinuxContextImplementation_nSetSwapInterval()
{
}

function Java_org_lwjgl_opengl_GL11_nglClearColor(lib, r, g, b, a, funcPtr)
{
	checkNoList(curList);
	return glCtx.clearColor(r, g, b, a);
}

function Java_org_lwjgl_opengl_GL11_nglClear(lib, a, funcPtr)
{
	checkNoList(curList);
	glCtx.clear(a);
}

function Java_org_lwjgl_opengl_LinuxContextImplementation_nSwapBuffers()
{
	if(verboseLog)
		console.warn("SwapBuffer");
	glCtx.bindFramebuffer(glCtx.DRAW_FRAMEBUFFER, null);
	glCtx.blitFramebuffer(0, 0, FBW, FBH, 0, 0, FBW, FBH, glCtx.COLOR_BUFFER_BIT, glCtx.NEAREST);
	glCtx.bindFramebuffer(glCtx.DRAW_FRAMEBUFFER, mainFb);
	frameCount++;
	if(frameCount == frameLimit)
	{
		console.warn("Stopping");
		return new Promise(function(){});
	}
	return new Promise(function(f, r)
	{
		requestAnimationFrame(f);
	});
}

function Java_org_lwjgl_opengl_LinuxEvent_getPending()
{
	return eventQueue.length;
}

function Java_org_lwjgl_opengl_GL11_nglMatrixMode(lib, matrixMode, funcPtr)
{
	if(curList)
		return pushInList(curList, arguments, Java_org_lwjgl_opengl_GL11_nglMatrixMode);
	if(matrixMode == 0x1700/*GL_MODELVIEW*/)
		curMatrixStack = modelViewMatrixStack;
	else if(matrixMode == 0x1701/*GL_PROJECTION*/)
		curMatrixStack = projMatrixStack;
	else if(matrixMode == 0x1702/*GL_TEXTURE*/)
		curMatrixStack = textureMatrixStack;
	else
		debugger;
}

function Java_org_lwjgl_opengl_GL11_nglLoadIdentity(lib, funcPtr)
{
	checkNoList(curList);
	glMatrix.mat4.identity(getCurMatrixTop());
}

function Java_org_lwjgl_opengl_GL11_nglOrtho(lib, left, right, bottom, top, nearVal, farVal, funcPtr)
{
	checkNoList(curList);
	var m = getCurMatrixTop();
	var o = glMatrix.mat4.create();
	glMatrix.mat4.ortho(o, left, right, bottom, top, nearVal, farVal);
	var out = glMatrix.mat4.create();
	setCurMatrixTop(glMatrix.mat4.multiply(out, m, o));
}

function Java_org_lwjgl_opengl_GL11_nglTranslatef(lib, x, y, z, funcPtr)
{
	if(curList)
		return pushInList(curList, arguments, Java_org_lwjgl_opengl_GL11_nglTranslatef);
	var m = getCurMatrixTop();
	var out = glMatrix.mat4.create();
	setCurMatrixTop(glMatrix.mat4.translate(out, m, glMatrix.vec3.fromValues(x, y, z)));
}

function Java_org_lwjgl_opengl_GL11_nglViewport(lib, x, y, width, height, funcPtr)
{
	checkNoList(curList);
	glCtx.viewport(x, y, width, height);
}

function Java_org_lwjgl_opengl_GL11_nglDisable(lib, a, funcPtr)
{
	checkNoList(curList);
	if(a == glCtx.BLEND || a == glCtx.CULL_FACE || a == glCtx.DEPTH_TEST)
		glCtx.disable(a);
	else if(a == 0x806F/*GL_TEXTURE_3D*/)
	{
		glCtx.uniform1f(texMaskLocation, 0);
	}
	else if(verboseLog)
		console.log("glDisable " + a.toString(16));
}

function Java_org_lwjgl_opengl_GL11_nglEnable(lib, a, funcPtr)
{
	checkNoList(curList);
	if(a == glCtx.BLEND || a == glCtx.CULL_FACE || a == glCtx.DEPTH_TEST)
		glCtx.enable(a);
	else if(a == 0x806F/*GL_TEXTURE_3D*/)
	{
	glCtx.uniform1f(texMaskLocation, 1);
	}
	else if(verboseLog)
		console.log("glEnable " + a.toString(16));
}

function Java_org_lwjgl_opengl_GL11_nglGenTextures(lib, n, memPtr, funcPtr)
{
	checkNoList(curList);
	var v = lib.getJNIDataView();
	var buf = new Int32Array(v.buffer, Number(memPtr), n);
	for(var i=0;i<n;i++)
	{
		var id = textureObjects.length;
		buf[i] = id;
		textureObjects[id] = glCtx.createTexture();
	}
}

function Java_org_lwjgl_opengl_GL11_nglBindTexture(lib, target, id, funcPtr)
{
	checkNoList(curList);
	assert(target == glCtx.TEXTURE_2D);
	glCtx.bindTexture(target, textureObjects[id]);
}

function Java_org_lwjgl_opengl_GL11_nglTexParameteri(lib, target, pname, param, funcPtr)
{
	checkNoList(curList);
	glCtx.texParameteri(target, pname, param);
}

function Java_org_lwjgl_opengl_GL11_nglTexImage2D(lib, target, level, internalFormat, width, height, border, format, type, memPtr, funcPtr)
{
	checkNoList(curList);
	assert(target == glCtx.TEXTURE_2D);
	var v = lib.getJNIDataView();
	// Build an unbound array, WebGL will truncate as needed
	var buf = new Uint8Array(v.buffer, Number(memPtr));
	glCtx.texImage2D(target, level, internalFormat, width, height, border, format, type, buf);
}

function Java_org_lwjgl_opengl_GL11_nglTexCoordPointer(lib, size, type, stride, memPtr, funcPtr)
{
	texCoordData.size = size;
	texCoordData.type = type;
	texCoordData.stride = stride;
	texCoordData.pointer = Number(memPtr);
}

function Java_org_lwjgl_opengl_GL11_nglEnableClientState(lib, v, funcPtr)
{
	if(v == 0x8074/*GL_VERTEX_ARRAY*/)
	{
		vertexData.enabled = true;
	}
	else if(v == 0x8075/*GL_NORMAL_ARRAY*/)
	{
		normalData.enabled = true;
	}
	else if(v == 0x8076/*GL_COLOR_ARRAY*/)
	{
		colorData.enabled = true;
	}
	else if(v == 0x8078/*GL_TEXTURE_COORD_ARRAY*/)
	{
		texCoordData.enabled = true;
	}
	else if(verboseLog)
	{
		console.log("glEnableClientState");
	}
}

function Java_org_lwjgl_opengl_GL11_nglColorPointer(lib, size, type, stride, memPtr, funcPtr)
{
	colorData.size = size;
	colorData.type = type;
	colorData.stride = stride;
	colorData.pointer = Number(memPtr);
}

function Java_org_lwjgl_opengl_GL11_nglVertexPointer(lib, size, type, stride, memPtr, funcPtr)
{
	vertexData.size = size;
	vertexData.type = type;
	vertexData.stride = stride;
	vertexData.pointer = Number(memPtr);
}

function Java_org_lwjgl_opengl_GL11_nglDrawArrays(lib, mode, first, count, funcPtr)
{
	var v = lib.getJNIDataView();
	if(curList)
	{
		// Capture client state at this point in time
		return pushDrawArraysInList(curList, v, mode, first, count);
	}
	// Upload vertex data
	uploadData(v, vertexData, vertexBuffer, vertexPosition, count);
	// Upload color data
	uploadData(v, colorData, colorBuffer, colorLocation, count);
	// Upload tex coord data
	uploadData(v, texCoordData, texCoordBuffer, texCoord, count);
	drawArraysImpl(mode, first, count);
}

function Java_org_lwjgl_opengl_GL11_nglDisableClientState(lib, v, funcPtr)
{
	if(v == 0x8074/*GL_VERTEX_ARRAY*/)
	{
		vertexData.enabled = false;
	}
	else if(v == 0x8075/*GL_NORMAL_ARRAY*/)
	{
		normalData.enabled = false;
	}
	else if(v == 0x8076/*GL_COLOR_ARRAY*/)
	{
		colorData.enabled = false;
	}
	else if(v == 0x8078/*GL_TEXTURE_COORD_ARRAY*/)
	{
		texCoordData.enabled = false;
	}
	else if(verboseLog)
	{
		console.log("glDisableClientState");
	}
}

function Java_org_lwjgl_opengl_GL11_nglColor4f(lib, r, g, b, a, funcPtr)
{
	checkNoList(curList);
	glCtx.vertexAttrib4f(colorLocation, r, g, b, a);
}

function Java_org_lwjgl_opengl_GL11_nglAlphaFunc()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glAlphaFunc");
}

function Java_org_lwjgl_opengl_GL11_nglGenLists(lib, range, funcPtr)
{
	checkNoList(curList);
	var ret = cmdLists.length;
	for(var i=0;i<range;i++)
		cmdLists.push([]);
	return ret;
}

function Java_org_lwjgl_opengl_GL11_nglNewList(lib, list, mode, funcPtr)
{
	checkNoList(curList);
	assert(mode == 0x1300/*GL_COMPILE*/);
	curList = cmdLists[list];
	// Wipe out the current contents of the list if any
	curList.length = 0;
}

function Java_org_lwjgl_opengl_GL11_nglEndList(lib, funcPtr)
{
	curList = null;
}

function Java_org_lwjgl_opengl_GL11_nglColor3f()
{
	if(curList)
		return pushInList(curList, arguments, Java_org_lwjgl_opengl_GL11_nglColor3f);
	if(verboseLog)
		console.log("glColor3f");
}

function Java_org_lwjgl_opengl_LinuxDisplay_nGetNativeCursorCapabilities()
{
}

function Java_org_lwjgl_opengl_GL11_nglShadeModel()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glShaderModel");
}

function Java_org_lwjgl_opengl_GL11_nglClearDepth(lib, a, funcPtr)
{
	checkNoList(curList);
	glCtx.clearDepth(a);
}

function Java_org_lwjgl_opengl_GL11_nglDepthFunc(lib, a, funcPtr)
{
	checkNoList(curList);
	glCtx.depthFunc(a);
}

function Java_org_lwjgl_opengl_GL11_nglCullFace(lib, mode, funcPtr)
{
	checkNoList(curList);
	glCtx.cullFace(mode);
}

function Java_org_lwjgl_opengl_GL11_nglPushMatrix(lib, funcPtr)
{
	if(curList)
		return pushInList(curList, arguments, Java_org_lwjgl_opengl_GL11_nglPushMatrix);
	curMatrixStack.push(glMatrix.mat4.clone(curMatrixStack[curMatrixStack.length - 1]));
}

function Java_org_lwjgl_opengl_GL11_nglPopMatrix(lib, funcPtr)
{
	if(curList)
		return pushInList(curList, arguments, Java_org_lwjgl_opengl_GL11_nglPopMatrix);
	curMatrixStack.pop();
}

function Java_org_lwjgl_opengl_GL11_nglMultMatrixf(lib, memPtr, funcPtr)
{
	checkNoList(curList);
	var m = getCurMatrixTop();
	var v = lib.getJNIDataView();
	var buf = new Float32Array(v.buffer, Number(memPtr), 16);
	var out = glMatrix.mat4.create();
	setCurMatrixTop(glMatrix.mat4.multiply(out, m, buf));
}

function Java_org_lwjgl_opengl_GL11_nglRotatef(lib, angle, x, y, z, funcPtr)
{
	checkNoList(curList);
	var m = getCurMatrixTop();
	var out = glMatrix.mat4.create();
	setCurMatrixTop(glMatrix.mat4.rotate(out, m, angle * Math.PI / 180.0, glMatrix.vec3.fromValues(x, y, z)));
}

function Java_org_lwjgl_opengl_GL11_nglDepthMask(lib, a, funcPtr)
{
	checkNoList(curList);
	glCtx.depthMask(a);
}

function Java_org_lwjgl_opengl_GL11_nglBlendFunc(lib, sfactor, dfactor)
{
	checkNoList(curList);
	glCtx.blendFunc(sfactor, dfactor);
}

function Java_org_lwjgl_opengl_GL11_nglColorMask(lib, r, g, b, a, funcPtr)
{
	checkNoList(curList);
	glCtx.colorMask(r, g, b, a);
}

function Java_org_lwjgl_opengl_GL11_nglCopyTexSubImage2D(lib, target, level, xoffset, yoffset, x, y, width, height, funcPtr)
{
	checkNoList(curList);
	glCtx.copyTexSubImage2D(target, level, xoffset, yoffset, x, y, width, height);
}

function Java_org_lwjgl_opengl_GL11_nglScalef(lib, x, y, z, funcPtr)
{
	if(curList)
		return pushInList(curList, arguments, Java_org_lwjgl_opengl_GL11_nglScalef);
	var m = getCurMatrixTop();
	var out = glMatrix.mat4.create();
	setCurMatrixTop(glMatrix.mat4.scale(out, m, glMatrix.vec3.fromValues(x, y, z)));
}

function Java_org_lwjgl_opengl_GL11_nglCallLists(lib, n, type, memPtr, funcPtr)
{
	checkNoList(curList);
	assert(type == glCtx.UNSIGNED_INT);
	var v = lib.getJNIDataView();
	var buf = new Int32Array(v.buffer, Number(memPtr), n);
	for(var i=0;i<n;i++)
		callList(buf[i]);
}

function Java_org_lwjgl_opengl_GL11_nglFlush()
{
	checkNoList(curList);
	glCtx.flush();
}

function Java_org_lwjgl_opengl_GL11_nglTexSubImage2D(lib, target, level, xoffset, yoffset, width, height, format, type, memPtr, funcPtr)
{
	checkNoList(curList);
	assert(target == glCtx.TEXTURE_2D);
	var v = lib.getJNIDataView();
	// Build an unbound array, WebGL will truncate as needed
	var buf = new Uint8Array(v.buffer, Number(memPtr));
	glCtx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, buf);
}

function Java_org_lwjgl_opengl_GL11_nglGetFloatv(lib, a, memPtr, funcPtr)
{
	checkNoList(curList);
	var v = lib.getJNIDataView();
	var buf = new Float32Array(v.buffer, Number(memPtr), 16);
	if(a == /*GL_MODELVIEW_MATRIX*/0xba6)
	{
		var m = modelViewMatrixStack[modelViewMatrixStack.length - 1];
		for(var i=0;i<16;i++)
			buf[i] = m[i];
	}
	else if(a == /*GL_PROJECTION_MATRIX*/0xba7)
	{
		var m = projMatrixStack[projMatrixStack.length - 1];
		for(var i=0;i<16;i++)
			buf[i] = m[i];
	}
	else if(verboseLog)
	{
		console.log("glGetFloat "+a);
	}
}

function Java_org_lwjgl_opengl_GL11_nglFogfv()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glFog");
}

function Java_org_lwjgl_opengl_GL11_nglNormal3f()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glNormal3f");
}

function Java_org_lwjgl_opengl_GL11_nglFogi()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glFogi");
}

function Java_org_lwjgl_opengl_GL11_nglFogf()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glFogf");
}

function Java_org_lwjgl_opengl_GL11_nglColorMaterial()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glColorMaterial");
}

function Java_org_lwjgl_opengl_GL11_nglCallList(lib, listId, funcPtr)
{
	checkNoList(curList);
	callList(listId);
}

function Java_org_lwjgl_opengl_GL13_nglActiveTexture()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glActiveTexture");
}

function Java_org_lwjgl_opengl_GL11_nglLightfv()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glLightfv");
}

function Java_org_lwjgl_opengl_GL11_nglLightModelfv()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glLightModelfv");
}

function Java_org_lwjgl_opengl_GL11_nglNormalPointer(lib, type, stride, memPtr, funcPtr)
{
	normalData.size = 3;
	normalData.type = type;
	normalData.stride = stride;
	normalData.pointer = Number(memPtr);
}

function Java_org_lwjgl_opengl_GL13_nglMultiTexCoord2f()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glMultiTexCoord2f");
}

function Java_org_lwjgl_opengl_GL13_nglClientActiveTexture()
{
	if(verboseLog)
		console.log("glClientActiveTexture");
}

function Java_org_lwjgl_opengl_GL11_nglLineWidth()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glLineWidth");
}

function Java_org_lwjgl_opengl_GL11_nglPolygonOffset()
{
	checkNoList(curList);
	if(verboseLog)
		console.log("glPolygonOffset");
}

function Java_org_lwjgl_opengl_GL11_nglBegin(lib, mode, funcPtr)
{
	checkNoList(curList);
	immediateModeData.mode = mode;
	immediateModeData.vertexPos = 0;
	immediateModeData.texCoordPos = 0;
}

function Java_org_lwjgl_opengl_GL11_nglTexCoord2f(lib, x, y, funcPtr)
{
	checkNoList(curList);
	var curPos = immediateModeData.texCoordPos;
	if(curPos > immediateModeData.texCoordBuf.length)
	{
		console.log("glTexCoord2f overflow");
		return;
	}
	immediateModeData.texCoordBuf[curPos] = x;
	immediateModeData.texCoordBuf[curPos + 1] = y;
	immediateModeData.texCoordPos = curPos + 2;
}

function Java_org_lwjgl_opengl_GL11_nglVertex3f(lib, x, y, z, funcPtr)
{
	checkNoList(curList);
	var curPos = immediateModeData.vertexPos;
	if(curPos > immediateModeData.vertexBuf.length)
	{
		console.log("glVertex3f overflow");
		return;
	}
	immediateModeData.vertexBuf[curPos] = x;
	immediateModeData.vertexBuf[curPos + 1] = y;
	immediateModeData.vertexBuf[curPos + 2] = z;
	immediateModeData.vertexPos = curPos + 3;
}

function Java_org_lwjgl_opengl_GL11_nglEnd(lib, funcPtr)
{
	checkNoList(curList);
	// Upload vertex data
	uploadDataImpl(immediateModeData.vertexBuf.subarray(0, immediateModeData.vertexPos), vertexBuffer, vertexPosition, 3, glCtx.FLOAT, 3 * 4);
	// TODO: Should we do something about color data?
	// Upload tex coord data
	uploadDataImpl(immediateModeData.texCoordBuf.subarray(0, immediateModeData.texCoordPos), texCoordBuffer, texCoord, 2, glCtx.FLOAT, 2 * 4);
	// NOTE: We count vertices
	drawArraysImpl(immediateModeData.mode, 0, immediateModeData.vertexPos / 3);
}

// These stubs make sure audio creation fails sooner rather than later
function Java_org_lwjgl_openal_AL_nCreate()
{
}

function Java_org_lwjgl_openal_AL10_initNativeStubs()
{
}

function Java_org_lwjgl_openal_ALC10_initNativeStubs()
{
}

function Java_org_lwjgl_openal_ALC10_nalcOpenDevice()
{
}

function Java_org_lwjgl_openal_AL_resetNativeStubs()
{
}

function Java_org_lwjgl_openal_AL_nDestroy()
{
}

// Basic input support
async function Java_org_lwjgl_opengl_LinuxEvent_createEventBuffer(lib)
{
	// This is intended to represent a X11 event, but we are free to use any layout
	var ByteBuffer = await lib.java.nio.ByteBuffer;
	return await ByteBuffer.allocateDirect(4 * 8);
}

async function Java_org_lwjgl_opengl_LinuxEvent_nNextEvent(lib, windowId, buffer)
{
	// Resolve the address and directly access the JNI memory
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	var e = eventQueue.shift();
	switch(e.type)
	{
		case "focus":
			v.setInt32(0, /*FocusIn*/9, true);
			break;
		case "mousedown":
			v.setInt32(0, /*ButtonPress*/4, true);
			v.setInt32(4, e.x, true);
			v.setInt32(8, e.y, true);
			v.setInt32(12, e.button, true);
			break;
		case "mouseup":
			v.setInt32(0, /*ButtonRelease*/5, true);
			v.setInt32(4, e.x, true);
			v.setInt32(8, e.y, true);
			v.setInt32(12, e.button, true);
			break;
		case "mousemove":
			v.setInt32(0, /*MotionNotify*/6, true);
			v.setInt32(4, e.x, true);
			v.setInt32(8, e.y, true);
			break;
		case "keydown":
			v.setInt32(0, /*KeyPress*/2, true);
			v.setInt32(4, e.keyCode, true);
			break;
		case "keyup":
			v.setInt32(0, /*KeyRelease*/3, true);
			v.setInt32(4, e.keyCode, true);
			break;
		default:
			debugger;
	}
}

function Java_org_lwjgl_opengl_LinuxEvent_nGetWindow()
{
	// Only a single window is emulated
	return 0;
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetType(lib, buffer)
{
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(0, true);
}

function Java_org_lwjgl_opengl_LinuxEvent_nFilterEvent()
{
}

function Java_org_lwjgl_opengl_LinuxEvent_nGetButtonTime()
{
	// TODO: Event timestamps
}

function Java_org_lwjgl_opengl_LinuxEvent_nGetButtonRoot()
{
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetButtonXRoot(lib, buffer)
{
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(4, true);
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetButtonYRoot(lib, buffer)
{
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(8, true);
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetButtonX(lib, buffer)
{
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(4, true);
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetButtonY(lib, buffer)
{
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(8, true);
}

function Java_org_lwjgl_opengl_LinuxEvent_nGetFocusDetail()
{
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetButtonType(lib, buffer)
{
	// Same as type, apparently
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(0, true);
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetButtonButton(lib, buffer)
{
	const v = lib.getJNIDataView();
	return v.getInt32(12, true);
}

function Java_org_lwjgl_opengl_LinuxDisplay_nGrabPointer()
{
	glCanvas.requestPointerLock();
	lockedMousePos = { x: 0, y: 0 };
}

function Java_org_lwjgl_opengl_LinuxDisplay_nUngrabPointer()
{
	document.exitPointerLock();
	lockedMousePos = null;
}

function Java_org_lwjgl_opengl_LinuxDisplay_nDefineCursor()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_getRootWindow()
{
}

function Java_org_lwjgl_opengl_LinuxDisplay_nSetWindowIcon()
{
}

function Java_org_lwjgl_opengl_LinuxMouse_nGetWindowWidth()
{
	return FBW;
}

function Java_org_lwjgl_opengl_LinuxMouse_nSendWarpEvent()
{
}

function Java_org_lwjgl_opengl_LinuxMouse_nWarpCursor()
{
}

function Java_org_lwjgl_opengl_LinuxEvent_nSetWindow()
{
}

function Java_org_lwjgl_opengl_LinuxEvent_nSendEvent()
{
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetKeyAddress(lib, buffer)
{
	// Should probably be a pointer, cheat and use directly the value
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(4, true);
}

function Java_org_lwjgl_opengl_LinuxEvent_nGetKeyTime()
{
	// TODO: Event timestamps
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetKeyType(lib, buffer)
{
	// Same as type, apparently
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(0, true);
}

async function Java_org_lwjgl_opengl_LinuxEvent_nGetKeyKeyCode(lib, buffer)
{
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	return v.getInt32(4, true);
}

function Java_org_lwjgl_opengl_LinuxEvent_nGetKeyState()
{
}

function Java_org_lwjgl_opengl_LinuxKeyboard_lookupKeysym(lib, eventPtr, index)
{
	return Number(eventPtr);
}

async function Java_org_lwjgl_opengl_LinuxKeyboard_lookupString(lib, eventPtr, buffer)
{
	// Only support single chars
	var bufferAddr = Number(await buffer.address());
	var v = lib.getJNIDataView();
	v.setInt8(bufferAddr, Number(eventPtr));
	return 1;
}


// ===== Adicionado para Minecraft Classic (funcoes que o jogo usa e o cheerpj-natives nao tinha) =====
function Java_org_lwjgl_opengl_GL11_nglVertex2f(lib, x, y, funcPtr)
{
	Java_org_lwjgl_opengl_GL11_nglVertex3f(lib, x, y, 0, funcPtr);
}

function Java_org_lwjgl_opengl_GL11_nglDeleteTextures(lib, n, memPtr, funcPtr)
{
	var v = lib.getJNIDataView();
	var buf = new Int32Array(v.buffer, Number(memPtr), n);
	for(var i=0;i<n;i++)
	{
		var id = buf[i];
		if(id > 0 && textureObjects[id])
		{
			glCtx.deleteTexture(textureObjects[id]);
			textureObjects[id] = null;
		}
	}
}

function Java_org_lwjgl_opengl_GL11_nglInterleavedArrays(lib, format, stride, memPtr, funcPtr)
{
	// formatos usados pelo Classic: V3F, C3F_V3F, T2F_V3F, T2F_C3F_V3F (todos float)
	var FLOAT = 0x1406, p = Number(memPtr);
	var hasT = false, hasC = false, off = 0, tOff = 0, cOff = 0, vOff = 0, size = 0;
	switch(format)
	{
		case 0x2A21: /*V3F*/ vOff = 0; size = 12; break;
		case 0x2A24: /*C3F_V3F*/ hasC = true; cOff = 0; vOff = 12; size = 24; break;
		case 0x2A27: /*T2F_V3F*/ hasT = true; tOff = 0; vOff = 8; size = 20; break;
		case 0x2A2A: /*T2F_C3F_V3F*/ hasT = true; hasC = true; tOff = 0; cOff = 8; vOff = 20; size = 32; break;
		default: console.log("glInterleavedArrays formato nao suportado: 0x" + format.toString(16)); return;
	}
	if(!stride) stride = size;
	vertexData.enabled = true; vertexData.size = 3; vertexData.type = FLOAT; vertexData.stride = stride; vertexData.pointer = p + vOff;
	normalData.enabled = false;
	colorData.enabled = hasC;
	if(hasC) { colorData.size = 3; colorData.type = FLOAT; colorData.stride = stride; colorData.pointer = p + cOff; }
	texCoordData.enabled = hasT;
	if(hasT) { texCoordData.size = 2; texCoordData.type = FLOAT; texCoordData.stride = stride; texCoordData.pointer = p + tOff; }
}

const __natives = {
	Java_org_lwjgl_DefaultSysImplementation_getPointerSize,
	Java_org_lwjgl_DefaultSysImplementation_getJNIVersion,
	Java_org_lwjgl_DefaultSysImplementation_setDebug,
	Java_org_lwjgl_opengl_LinuxDisplay_nLockAWT,
	Java_org_lwjgl_opengl_LinuxDisplay_nUnlockAWT,
	Java_org_lwjgl_opengl_LinuxDisplay_setErrorHandler,
	Java_org_lwjgl_opengl_LinuxDisplay_openDisplay,
	Java_org_lwjgl_opengl_LinuxDisplay_nInternAtom,
	Java_org_lwjgl_opengl_LinuxDisplay_nIsXrandrSupported,
	Java_org_lwjgl_opengl_LinuxDisplay_nIsXF86VidModeSupported,
	Java_org_lwjgl_opengl_LinuxDisplay_nGetDefaultScreen,
	Java_org_lwjgl_opengl_LinuxDisplay_nGetAvailableDisplayModes,
	Java_org_lwjgl_opengl_LinuxDisplay_nGetCurrentGammaRamp,
	Java_org_lwjgl_opengl_LinuxPeerInfo_createHandle,
	Java_org_lwjgl_opengl_GLContext_nLoadOpenGLLibrary,
	Java_org_lwjgl_opengl_LinuxDisplayPeerInfo_initDefaultPeerInfo,
	Java_org_lwjgl_opengl_LinuxDisplayPeerInfo_initDrawable,
	Java_org_lwjgl_opengl_AWTSurfaceLock_createHandle,
	Java_org_lwjgl_opengl_AWTSurfaceLock_lockAndInitHandle,
	Java_org_lwjgl_opengl_LinuxAWTGLCanvasPeerInfo_getScreenFromSurfaceInfo,
	Java_org_lwjgl_opengl_LinuxAWTGLCanvasPeerInfo_nInitHandle,
	Java_org_lwjgl_opengl_AWTSurfaceLock_nUnlock,
	Java_org_lwjgl_opengl_LinuxPeerInfo_nGetDrawable,
	Java_org_lwjgl_opengl_LinuxDisplay_nCreateWindow,
	Java_org_lwjgl_opengl_LinuxDisplay_mapRaised,
	Java_org_lwjgl_opengl_LinuxDisplay_nCreateBlankCursor,
	Java_org_lwjgl_opengl_LinuxDisplay_nSetTitle,
	Java_org_lwjgl_opengl_LinuxMouse_nGetButtonCount,
	Java_org_lwjgl_opengl_LinuxMouse_nQueryPointer,
	Java_org_lwjgl_opengl_LinuxMouse_nGetWindowHeight,
	Java_org_lwjgl_opengl_LinuxKeyboard_getModifierMapping,
	Java_org_lwjgl_opengl_LinuxKeyboard_nSetDetectableKeyRepeat,
	Java_org_lwjgl_opengl_LinuxKeyboard_openIM,
	Java_org_lwjgl_opengl_LinuxKeyboard_allocateComposeStatus,
	Java_org_lwjgl_opengl_LinuxContextImplementation_nCreate,
	Java_org_lwjgl_opengl_LinuxContextImplementation_nMakeCurrent,
	Java_org_lwjgl_opengl_LinuxContextImplementation_nIsCurrent,
	Java_org_lwjgl_opengl_GLContext_ngetFunctionAddress,
	Java_org_lwjgl_opengl_GL11_nglGetString,
	Java_org_lwjgl_opengl_GL11_nglGetIntegerv,
	Java_org_lwjgl_opengl_GL11_nglGetError,
	Java_org_lwjgl_opengl_LinuxContextImplementation_nSetSwapInterval,
	Java_org_lwjgl_opengl_GL11_nglClearColor,
	Java_org_lwjgl_opengl_GL11_nglClear,
	Java_org_lwjgl_opengl_LinuxContextImplementation_nSwapBuffers,
	Java_org_lwjgl_opengl_LinuxEvent_getPending,
	Java_org_lwjgl_opengl_GL11_nglMatrixMode,
	Java_org_lwjgl_opengl_GL11_nglLoadIdentity,
	Java_org_lwjgl_opengl_GL11_nglOrtho,
	Java_org_lwjgl_opengl_GL11_nglTranslatef,
	Java_org_lwjgl_opengl_GL11_nglViewport,
	Java_org_lwjgl_opengl_GL11_nglDisable,
	Java_org_lwjgl_opengl_GL11_nglEnable,
	Java_org_lwjgl_opengl_GL11_nglGenTextures,
	Java_org_lwjgl_opengl_GL11_nglBindTexture,
	Java_org_lwjgl_opengl_GL11_nglTexParameteri,
	Java_org_lwjgl_opengl_GL11_nglTexImage2D,
	Java_org_lwjgl_opengl_GL11_nglTexCoordPointer,
	Java_org_lwjgl_opengl_GL11_nglEnableClientState,
	Java_org_lwjgl_opengl_GL11_nglColorPointer,
	Java_org_lwjgl_opengl_GL11_nglVertexPointer,
	Java_org_lwjgl_opengl_GL11_nglDrawArrays,
	Java_org_lwjgl_opengl_GL11_nglDisableClientState,
	Java_org_lwjgl_opengl_GL11_nglColor4f,
	Java_org_lwjgl_opengl_GL11_nglAlphaFunc,
	Java_org_lwjgl_opengl_GL11_nglGenLists,
	Java_org_lwjgl_opengl_GL11_nglNewList,
	Java_org_lwjgl_opengl_GL11_nglEndList,
	Java_org_lwjgl_opengl_GL11_nglColor3f,
	Java_org_lwjgl_opengl_LinuxDisplay_nGetNativeCursorCapabilities,
	Java_org_lwjgl_opengl_GL11_nglShadeModel,
	Java_org_lwjgl_opengl_GL11_nglClearDepth,
	Java_org_lwjgl_opengl_GL11_nglDepthFunc,
	Java_org_lwjgl_opengl_GL11_nglCullFace,
	Java_org_lwjgl_opengl_GL11_nglPushMatrix,
	Java_org_lwjgl_opengl_GL11_nglPopMatrix,
	Java_org_lwjgl_opengl_GL11_nglMultMatrixf,
	Java_org_lwjgl_opengl_GL11_nglRotatef,
	Java_org_lwjgl_opengl_GL11_nglDepthMask,
	Java_org_lwjgl_opengl_GL11_nglBlendFunc,
	Java_org_lwjgl_opengl_GL11_nglColorMask,
	Java_org_lwjgl_opengl_GL11_nglCopyTexSubImage2D,
	Java_org_lwjgl_opengl_GL11_nglScalef,
	Java_org_lwjgl_opengl_GL11_nglCallLists,
	Java_org_lwjgl_opengl_GL11_nglFlush,
	Java_org_lwjgl_opengl_GL11_nglTexSubImage2D,
	Java_org_lwjgl_opengl_GL11_nglGetFloatv,
	Java_org_lwjgl_opengl_GL11_nglFogfv,
	Java_org_lwjgl_opengl_GL11_nglNormal3f,
	Java_org_lwjgl_opengl_GL11_nglFogi,
	Java_org_lwjgl_opengl_GL11_nglFogf,
	Java_org_lwjgl_opengl_GL11_nglColorMaterial,
	Java_org_lwjgl_opengl_GL11_nglCallList,
	Java_org_lwjgl_opengl_GL13_nglActiveTexture,
	Java_org_lwjgl_opengl_GL11_nglLightfv,
	Java_org_lwjgl_opengl_GL11_nglLightModelfv,
	Java_org_lwjgl_opengl_GL11_nglNormalPointer,
	Java_org_lwjgl_opengl_GL13_nglMultiTexCoord2f,
	Java_org_lwjgl_opengl_GL13_nglClientActiveTexture,
	Java_org_lwjgl_opengl_GL11_nglLineWidth,
	Java_org_lwjgl_opengl_GL11_nglPolygonOffset,
	Java_org_lwjgl_opengl_GL11_nglBegin,
	Java_org_lwjgl_opengl_GL11_nglTexCoord2f,
	Java_org_lwjgl_opengl_GL11_nglVertex3f,
	Java_org_lwjgl_opengl_GL11_nglEnd,
	Java_org_lwjgl_openal_AL_nCreate,
	Java_org_lwjgl_openal_AL10_initNativeStubs,
	Java_org_lwjgl_openal_ALC10_initNativeStubs,
	Java_org_lwjgl_openal_ALC10_nalcOpenDevice,
	Java_org_lwjgl_openal_AL_resetNativeStubs,
	Java_org_lwjgl_openal_AL_nDestroy,
	Java_org_lwjgl_opengl_LinuxEvent_createEventBuffer,
	Java_org_lwjgl_opengl_LinuxEvent_nNextEvent,
	Java_org_lwjgl_opengl_LinuxEvent_nGetWindow,
	Java_org_lwjgl_opengl_LinuxEvent_nGetType,
	Java_org_lwjgl_opengl_LinuxEvent_nFilterEvent,
	Java_org_lwjgl_opengl_LinuxEvent_nGetButtonTime,
	Java_org_lwjgl_opengl_LinuxEvent_nGetButtonRoot,
	Java_org_lwjgl_opengl_LinuxEvent_nGetButtonXRoot,
	Java_org_lwjgl_opengl_LinuxEvent_nGetButtonYRoot,
	Java_org_lwjgl_opengl_LinuxEvent_nGetButtonX,
	Java_org_lwjgl_opengl_LinuxEvent_nGetButtonY,
	Java_org_lwjgl_opengl_LinuxEvent_nGetFocusDetail,
	Java_org_lwjgl_opengl_LinuxEvent_nGetButtonType,
	Java_org_lwjgl_opengl_LinuxEvent_nGetButtonButton,
	Java_org_lwjgl_opengl_LinuxDisplay_nGrabPointer,
	Java_org_lwjgl_opengl_LinuxDisplay_nUngrabPointer,
	Java_org_lwjgl_opengl_LinuxDisplay_nDefineCursor,
	Java_org_lwjgl_opengl_LinuxDisplay_getRootWindow,
	Java_org_lwjgl_opengl_LinuxDisplay_nSetWindowIcon,
	Java_org_lwjgl_opengl_LinuxMouse_nGetWindowWidth,
	Java_org_lwjgl_opengl_LinuxMouse_nSendWarpEvent,
	Java_org_lwjgl_opengl_LinuxMouse_nWarpCursor,
	Java_org_lwjgl_opengl_LinuxEvent_nSetWindow,
	Java_org_lwjgl_opengl_LinuxEvent_nSendEvent,
	Java_org_lwjgl_opengl_LinuxEvent_nGetKeyAddress,
	Java_org_lwjgl_opengl_LinuxEvent_nGetKeyTime,
	Java_org_lwjgl_opengl_LinuxEvent_nGetKeyType,
	Java_org_lwjgl_opengl_LinuxEvent_nGetKeyKeyCode,
	Java_org_lwjgl_opengl_LinuxEvent_nGetKeyState,
	Java_org_lwjgl_opengl_LinuxKeyboard_lookupKeysym,
	Java_org_lwjgl_opengl_LinuxKeyboard_lookupString,
	Java_org_lwjgl_opengl_GL11_nglVertex2f,
	Java_org_lwjgl_opengl_GL11_nglDeleteTextures,
	Java_org_lwjgl_opengl_GL11_nglInterleavedArrays,
};

// ===== Adaptacao LWJGL 2.4.2 (jar) <-> natives escritos para LWJGL 2.9 =====
// 1) 2.4.2 chama GLContext.getFunctionAddress(String) (2.9 usava ngetFunctionAddress)
__natives.Java_org_lwjgl_opengl_GLContext_getFunctionAddress = function(lib, name) { return 1; };

// 2) Em 2.4.2 funcoes com buffer recebem (Buffer, int offsetBytes, long funcPtr);
//    em 2.9 recebiam (long memPtr, long funcPtr). Convertemos buffer+offset -> endereco.
const __bufArgs = {
	Java_org_lwjgl_opengl_GL11_nglGetIntegerv: 1,
	Java_org_lwjgl_opengl_GL11_nglGenTextures: 1,
	Java_org_lwjgl_opengl_GL11_nglDeleteTextures: 1,
	Java_org_lwjgl_opengl_GL11_nglTexImage2D: 8,
	Java_org_lwjgl_opengl_GL11_nglTexSubImage2D: 8,
	Java_org_lwjgl_opengl_GL11_nglTexCoordPointer: 3,
	Java_org_lwjgl_opengl_GL11_nglColorPointer: 3,
	Java_org_lwjgl_opengl_GL11_nglVertexPointer: 3,
	Java_org_lwjgl_opengl_GL11_nglNormalPointer: 2,
	Java_org_lwjgl_opengl_GL11_nglMultMatrixf: 0,
	Java_org_lwjgl_opengl_GL11_nglCallLists: 2,
	Java_org_lwjgl_opengl_GL11_nglGetFloatv: 1,
	Java_org_lwjgl_opengl_GL11_nglInterleavedArrays: 2,
};
for (const [name, idx] of Object.entries(__bufArgs))
{
	const orig = __natives[name];
	if (!orig) { console.warn("natives: faltando", name); continue; }
	__natives[name] = async function(lib, ...args)
	{
		const b = args[idx], off = Number(args[idx + 1]) || 0;
		const base = b ? Number(await b.address()) : 0;
		args.splice(idx, 2, base + off);
		return orig.call(this, lib, ...args);
	};
}

// 3) Funcoes que 2.4.2 exige e 2.9 nao tinha (no-ops)
for (const n of [
	"Java_org_lwjgl_opengl_GLContext_nUnloadOpenGLLibrary",
	"Java_org_lwjgl_opengl_GLContext_resetNativeStubs",
	"Java_org_lwjgl_opengl_LinuxContextImplementation_nDestroy",
	"Java_org_lwjgl_opengl_LinuxContextImplementation_nReleaseCurrentContext",
])
	if (!__natives[n]) __natives[n] = function() {};

// ===== Stubs automaticos para natives do LWJGL 2.4.2 ainda nao implementados =====
// Retornam valor padrao (0/false/null) e avisam uma vez no console.
const __stubTable = {
	"openal_AL_nCreateDefault":"V",
	"openal_AL10_alEnable":"V",
	"openal_AL10_alDisable":"V",
	"openal_AL10_alIsEnabled":"Z",
	"openal_AL10_alGetBoolean":"Z",
	"openal_AL10_alGetInteger":"I",
	"openal_AL10_alGetFloat":"F",
	"openal_AL10_alGetDouble":"D",
	"openal_AL10_nalGetIntegerv":"V",
	"openal_AL10_nalGetFloatv":"V",
	"openal_AL10_nalGetDoublev":"V",
	"openal_AL10_alGetString":"L",
	"openal_AL10_alGetError":"I",
	"openal_AL10_nalIsExtensionPresent":"Z",
	"openal_AL10_nalGetEnumValue":"I",
	"openal_AL10_alListeneri":"V",
	"openal_AL10_alListenerf":"V",
	"openal_AL10_nalListenerfv":"V",
	"openal_AL10_alListener3f":"V",
	"openal_AL10_alGetListeneri":"I",
	"openal_AL10_alGetListenerf":"F",
	"openal_AL10_nalGetListenerfv":"V",
	"openal_AL10_nalGenSources":"V",
	"openal_AL10_nalGenSources2":"I",
	"openal_AL10_nalDeleteSources":"V",
	"openal_AL10_nalDeleteSources2":"V",
	"openal_AL10_alIsSource":"Z",
	"openal_AL10_alSourcei":"V",
	"openal_AL10_alSourcef":"V",
	"openal_AL10_nalSourcefv":"V",
	"openal_AL10_alSource3f":"V",
	"openal_AL10_alGetSourcei":"I",
	"openal_AL10_alGetSourcef":"F",
	"openal_AL10_nalGetSourcefv":"V",
	"openal_AL10_nalSourcePlayv":"V",
	"openal_AL10_nalSourcePausev":"V",
	"openal_AL10_nalSourceStopv":"V",
	"openal_AL10_nalSourceRewindv":"V",
	"openal_AL10_alSourcePlay":"V",
	"openal_AL10_alSourcePause":"V",
	"openal_AL10_alSourceStop":"V",
	"openal_AL10_alSourceRewind":"V",
	"openal_AL10_nalGenBuffers":"V",
	"openal_AL10_nalGenBuffers2":"I",
	"openal_AL10_nalDeleteBuffers":"V",
	"openal_AL10_nalDeleteBuffers2":"V",
	"openal_AL10_alIsBuffer":"Z",
	"openal_AL10_nalBufferData":"V",
	"openal_AL10_alGetBufferi":"I",
	"openal_AL10_alGetBufferf":"F",
	"openal_AL10_nalSourceQueueBuffers":"V",
	"openal_AL10_nalSourceQueueBuffers2":"V",
	"openal_AL10_nalSourceUnqueueBuffers":"V",
	"openal_AL10_nalSourceUnqueueBuffers2":"I",
	"openal_AL10_alDistanceModel":"V",
	"openal_AL10_alDopplerFactor":"V",
	"openal_AL10_alDopplerVelocity":"V",
	"openal_AL11_initNativeStubs":"V",
	"openal_AL11_alListener3i":"V",
	"openal_AL11_nalGetListeneriv":"V",
	"openal_AL11_alSource3i":"V",
	"openal_AL11_nalSourceiv":"V",
	"openal_AL11_alBufferf":"V",
	"openal_AL11_alBuffer3f":"V",
	"openal_AL11_nalBufferfv":"V",
	"openal_AL11_alBufferi":"V",
	"openal_AL11_alBuffer3i":"V",
	"openal_AL11_nalBufferiv":"V",
	"openal_AL11_alGetBufferi":"I",
	"openal_AL11_nalGetBufferiv":"V",
	"openal_AL11_alGetBufferf":"F",
	"openal_AL11_nalGetBufferfv":"V",
	"openal_AL11_alSpeedOfSound":"V",
	"openal_ALC10_nalcGetString":"L",
	"openal_ALC10_nalcGetIntegerv":"V",
	"openal_ALC10_nalcCloseDevice":"Z",
	"openal_ALC10_nalcCreateContext":"J",
	"openal_ALC10_nalcMakeContextCurrent":"I",
	"openal_ALC10_nalcProcessContext":"V",
	"openal_ALC10_nalcGetCurrentContext":"J",
	"openal_ALC10_nalcGetContextsDevice":"J",
	"openal_ALC10_nalcSuspendContext":"V",
	"openal_ALC10_nalcDestroyContext":"V",
	"openal_ALC10_nalcGetError":"I",
	"openal_ALC10_nalcIsExtensionPresent":"Z",
	"openal_ALC10_nalcGetEnumValue":"I",
	"openal_ALC11_nalcCaptureOpenDevice":"J",
	"openal_ALC11_nalcCaptureCloseDevice":"Z",
	"openal_ALC11_nalcCaptureStart":"V",
	"openal_ALC11_nalcCaptureStop":"V",
	"openal_ALC11_nalcCaptureSamples":"V",
	"openal_ALC11_initNativeStubs":"V",
	"opengl_GL11_nglAccum":"V",
	"opengl_GL11_nglClearAccum":"V",
	"opengl_GL11_nglBitmap":"V",
	"opengl_GL11_nglBitmapBO":"V",
	"opengl_GL11_nglPrioritizeTextures":"V",
	"opengl_GL11_nglAreTexturesResident":"Z",
	"opengl_GL11_nglArrayElement":"V",
	"opengl_GL11_nglDeleteLists":"V",
	"opengl_GL11_nglCopyTexSubImage1D":"V",
	"opengl_GL11_nglCopyTexImage2D":"V",
	"opengl_GL11_nglCopyTexImage1D":"V",
	"opengl_GL11_nglCopyPixels":"V",
	"opengl_GL11_nglColorPointerBO":"V",
	"opengl_GL11_nglColor3b":"V",
	"opengl_GL11_nglColor3d":"V",
	"opengl_GL11_nglColor3ub":"V",
	"opengl_GL11_nglColor4b":"V",
	"opengl_GL11_nglColor4d":"V",
	"opengl_GL11_nglColor4ub":"V",
	"opengl_GL11_nglClipPlane":"V",
	"opengl_GL11_nglClearStencil":"V",
	"opengl_GL11_nglEvalPoint1":"V",
	"opengl_GL11_nglEvalPoint2":"V",
	"opengl_GL11_nglEvalMesh1":"V",
	"opengl_GL11_nglEvalMesh2":"V",
	"opengl_GL11_nglEvalCoord1f":"V",
	"opengl_GL11_nglEvalCoord1d":"V",
	"opengl_GL11_nglEvalCoord2f":"V",
	"opengl_GL11_nglEvalCoord2d":"V",
	"opengl_GL11_nglEdgeFlagPointer":"V",
	"opengl_GL11_nglEdgeFlagPointerBO":"V",
	"opengl_GL11_nglEdgeFlag":"V",
	"opengl_GL11_nglDrawPixels":"V",
	"opengl_GL11_nglDrawPixelsBO":"V",
	"opengl_GL11_nglDrawElements":"V",
	"opengl_GL11_nglDrawElementsBO":"V",
	"opengl_GL11_nglDrawBuffer":"V",
	"opengl_GL11_nglDepthRange":"V",
	"opengl_GL11_nglFeedbackBuffer":"V",
	"opengl_GL11_nglGetPixelMapfv":"V",
	"opengl_GL11_nglGetPixelMapfvBO":"V",
	"opengl_GL11_nglGetPixelMapuiv":"V",
	"opengl_GL11_nglGetPixelMapuivBO":"V",
	"opengl_GL11_nglGetPixelMapusv":"V",
	"opengl_GL11_nglGetPixelMapusvBO":"V",
	"opengl_GL11_nglGetMaterialfv":"V",
	"opengl_GL11_nglGetMaterialiv":"V",
	"opengl_GL11_nglGetMapfv":"V",
	"opengl_GL11_nglGetMapdv":"V",
	"opengl_GL11_nglGetMapiv":"V",
	"opengl_GL11_nglGetLightfv":"V",
	"opengl_GL11_nglGetLightiv":"V",
	"opengl_GL11_nglGetClipPlane":"V",
	"opengl_GL11_nglGetBooleanv":"V",
	"opengl_GL11_nglGetDoublev":"V",
	"opengl_GL11_nglFrustum":"V",
	"opengl_GL11_nglFrontFace":"V",
	"opengl_GL11_nglFogiv":"V",
	"opengl_GL11_nglFinish":"V",
	"opengl_GL11_nglGetPointerv":"L",
	"opengl_GL11_nglIsEnabled":"Z",
	"opengl_GL11_nglInterleavedArraysBO":"V",
	"opengl_GL11_nglInitNames":"V",
	"opengl_GL11_nglHint":"V",
	"opengl_GL11_nglGetTexParameterfv":"V",
	"opengl_GL11_nglGetTexParameteriv":"V",
	"opengl_GL11_nglGetTexLevelParameterfv":"V",
	"opengl_GL11_nglGetTexLevelParameteriv":"V",
	"opengl_GL11_nglGetTexImage":"V",
	"opengl_GL11_nglGetTexImageBO":"V",
	"opengl_GL11_nglGetTexGeniv":"V",
	"opengl_GL11_nglGetTexGenfv":"V",
	"opengl_GL11_nglGetTexGendv":"V",
	"opengl_GL11_nglGetTexEnviv":"V",
	"opengl_GL11_nglGetTexEnvfv":"V",
	"opengl_GL11_nglGetPolygonStipple":"V",
	"opengl_GL11_nglGetPolygonStippleBO":"V",
	"opengl_GL11_nglIsList":"Z",
	"opengl_GL11_nglMaterialf":"V",
	"opengl_GL11_nglMateriali":"V",
	"opengl_GL11_nglMaterialfv":"V",
	"opengl_GL11_nglMaterialiv":"V",
	"opengl_GL11_nglMapGrid1f":"V",
	"opengl_GL11_nglMapGrid1d":"V",
	"opengl_GL11_nglMapGrid2f":"V",
	"opengl_GL11_nglMapGrid2d":"V",
	"opengl_GL11_nglMap2f":"V",
	"opengl_GL11_nglMap2d":"V",
	"opengl_GL11_nglMap1f":"V",
	"opengl_GL11_nglMap1d":"V",
	"opengl_GL11_nglLogicOp":"V",
	"opengl_GL11_nglLoadName":"V",
	"opengl_GL11_nglLoadMatrixf":"V",
	"opengl_GL11_nglLoadMatrixd":"V",
	"opengl_GL11_nglListBase":"V",
	"opengl_GL11_nglLineStipple":"V",
	"opengl_GL11_nglLightModelf":"V",
	"opengl_GL11_nglLightModeli":"V",
	"opengl_GL11_nglLightModeliv":"V",
	"opengl_GL11_nglLightf":"V",
	"opengl_GL11_nglLighti":"V",
	"opengl_GL11_nglLightiv":"V",
	"opengl_GL11_nglIsTexture":"Z",
	"opengl_GL11_nglPolygonStipple":"V",
	"opengl_GL11_nglPolygonStippleBO":"V",
	"opengl_GL11_nglPolygonMode":"V",
	"opengl_GL11_nglPointSize":"V",
	"opengl_GL11_nglPixelZoom":"V",
	"opengl_GL11_nglPixelTransferf":"V",
	"opengl_GL11_nglPixelTransferi":"V",
	"opengl_GL11_nglPixelStoref":"V",
	"opengl_GL11_nglPixelStorei":"V",
	"opengl_GL11_nglPixelMapfv":"V",
	"opengl_GL11_nglPixelMapfvBO":"V",
	"opengl_GL11_nglPixelMapuiv":"V",
	"opengl_GL11_nglPixelMapuivBO":"V",
	"opengl_GL11_nglPixelMapusv":"V",
	"opengl_GL11_nglPixelMapusvBO":"V",
	"opengl_GL11_nglPassThrough":"V",
	"opengl_GL11_nglNormalPointerBO":"V",
	"opengl_GL11_nglNormal3b":"V",
	"opengl_GL11_nglNormal3d":"V",
	"opengl_GL11_nglNormal3i":"V",
	"opengl_GL11_nglMultMatrixd":"V",
	"opengl_GL11_nglSelectBuffer":"V",
	"opengl_GL11_nglScissor":"V",
	"opengl_GL11_nglScaled":"V",
	"opengl_GL11_nglRenderMode":"I",
	"opengl_GL11_nglRectf":"V",
	"opengl_GL11_nglRectd":"V",
	"opengl_GL11_nglRecti":"V",
	"opengl_GL11_nglReadPixels":"V",
	"opengl_GL11_nglReadPixelsBO":"V",
	"opengl_GL11_nglReadBuffer":"V",
	"opengl_GL11_nglRasterPos2f":"V",
	"opengl_GL11_nglRasterPos2d":"V",
	"opengl_GL11_nglRasterPos2i":"V",
	"opengl_GL11_nglRasterPos3f":"V",
	"opengl_GL11_nglRasterPos3d":"V",
	"opengl_GL11_nglRasterPos3i":"V",
	"opengl_GL11_nglRasterPos4f":"V",
	"opengl_GL11_nglRasterPos4d":"V",
	"opengl_GL11_nglRasterPos4i":"V",
	"opengl_GL11_nglPushName":"V",
	"opengl_GL11_nglPopName":"V",
	"opengl_GL11_nglPushClientAttrib":"V",
	"opengl_GL11_nglPopClientAttrib":"V",
	"opengl_GL11_nglPushAttrib":"V",
	"opengl_GL11_nglPopAttrib":"V",
	"opengl_GL11_nglStencilFunc":"V",
	"opengl_GL11_nglVertexPointerBO":"V",
	"opengl_GL11_nglVertex2d":"V",
	"opengl_GL11_nglVertex2i":"V",
	"opengl_GL11_nglVertex3d":"V",
	"opengl_GL11_nglVertex3i":"V",
	"opengl_GL11_nglVertex4f":"V",
	"opengl_GL11_nglVertex4d":"V",
	"opengl_GL11_nglVertex4i":"V",
	"opengl_GL11_nglTranslated":"V",
	"opengl_GL11_nglTexImage1D":"V",
	"opengl_GL11_nglTexImage1DBO":"V",
	"opengl_GL11_nglTexImage2DBO":"V",
	"opengl_GL11_nglTexSubImage1D":"V",
	"opengl_GL11_nglTexSubImage1DBO":"V",
	"opengl_GL11_nglTexSubImage2DBO":"V",
	"opengl_GL11_nglTexParameterf":"V",
	"opengl_GL11_nglTexParameterfv":"V",
	"opengl_GL11_nglTexParameteriv":"V",
	"opengl_GL11_nglTexGenf":"V",
	"opengl_GL11_nglTexGend":"V",
	"opengl_GL11_nglTexGenfv":"V",
	"opengl_GL11_nglTexGendv":"V",
	"opengl_GL11_nglTexGeni":"V",
	"opengl_GL11_nglTexGeniv":"V",
	"opengl_GL11_nglTexEnvf":"V",
	"opengl_GL11_nglTexEnvi":"V",
	"opengl_GL11_nglTexEnvfv":"V",
	"opengl_GL11_nglTexEnviv":"V",
	"opengl_GL11_nglTexCoordPointerBO":"V",
	"opengl_GL11_nglTexCoord1f":"V",
	"opengl_GL11_nglTexCoord1d":"V",
	"opengl_GL11_nglTexCoord2d":"V",
	"opengl_GL11_nglTexCoord3f":"V",
	"opengl_GL11_nglTexCoord3d":"V",
	"opengl_GL11_nglTexCoord4f":"V",
	"opengl_GL11_nglTexCoord4d":"V",
	"opengl_GL11_nglStencilOp":"V",
	"opengl_GL11_nglStencilMask":"V",
	"opengl_GL12_nglDrawRangeElements":"V",
	"opengl_GL12_nglDrawRangeElementsBO":"V",
	"opengl_GL12_nglTexImage3D":"V",
	"opengl_GL12_nglTexImage3DBO":"V",
	"opengl_GL12_nglTexSubImage3D":"V",
	"opengl_GL12_nglTexSubImage3DBO":"V",
	"opengl_GL12_nglCopyTexSubImage3D":"V",
	"opengl_GL13_nglCompressedTexImage1D":"V",
	"opengl_GL13_nglCompressedTexImage1DBO":"V",
	"opengl_GL13_nglCompressedTexImage2D":"V",
	"opengl_GL13_nglCompressedTexImage2DBO":"V",
	"opengl_GL13_nglCompressedTexImage3D":"V",
	"opengl_GL13_nglCompressedTexImage3DBO":"V",
	"opengl_GL13_nglCompressedTexSubImage1D":"V",
	"opengl_GL13_nglCompressedTexSubImage1DBO":"V",
	"opengl_GL13_nglCompressedTexSubImage2D":"V",
	"opengl_GL13_nglCompressedTexSubImage2DBO":"V",
	"opengl_GL13_nglCompressedTexSubImage3D":"V",
	"opengl_GL13_nglCompressedTexSubImage3DBO":"V",
	"opengl_GL13_nglGetCompressedTexImage":"V",
	"opengl_GL13_nglGetCompressedTexImageBO":"V",
	"opengl_GL13_nglMultiTexCoord1f":"V",
	"opengl_GL13_nglMultiTexCoord1d":"V",
	"opengl_GL13_nglMultiTexCoord2d":"V",
	"opengl_GL13_nglMultiTexCoord3f":"V",
	"opengl_GL13_nglMultiTexCoord3d":"V",
	"opengl_GL13_nglMultiTexCoord4f":"V",
	"opengl_GL13_nglMultiTexCoord4d":"V",
	"opengl_GL13_nglLoadTransposeMatrixf":"V",
	"opengl_GL13_nglLoadTransposeMatrixd":"V",
	"opengl_GL13_nglMultTransposeMatrixf":"V",
	"opengl_GL13_nglMultTransposeMatrixd":"V",
	"opengl_GL13_nglSampleCoverage":"V",
	"opengl_GL14_nglBlendEquation":"V",
	"opengl_GL14_nglBlendColor":"V",
	"opengl_GL14_nglFogCoordf":"V",
	"opengl_GL14_nglFogCoordd":"V",
	"opengl_GL14_nglFogCoordPointer":"V",
	"opengl_GL14_nglFogCoordPointerBO":"V",
	"opengl_GL14_nglMultiDrawArrays":"V",
	"opengl_GL14_nglPointParameteri":"V",
	"opengl_GL14_nglPointParameterf":"V",
	"opengl_GL14_nglPointParameteriv":"V",
	"opengl_GL14_nglPointParameterfv":"V",
	"opengl_GL14_nglSecondaryColor3b":"V",
	"opengl_GL14_nglSecondaryColor3f":"V",
	"opengl_GL14_nglSecondaryColor3d":"V",
	"opengl_GL14_nglSecondaryColor3ub":"V",
	"opengl_GL14_nglSecondaryColorPointer":"V",
	"opengl_GL14_nglSecondaryColorPointerBO":"V",
	"opengl_GL14_nglBlendFuncSeparate":"V",
	"opengl_GL14_nglWindowPos2f":"V",
	"opengl_GL14_nglWindowPos2d":"V",
	"opengl_GL14_nglWindowPos2i":"V",
	"opengl_GL14_nglWindowPos3f":"V",
	"opengl_GL14_nglWindowPos3d":"V",
	"opengl_GL14_nglWindowPos3i":"V",
	"opengl_GL15_nglBindBuffer":"V",
	"opengl_GL15_nglDeleteBuffers":"V",
	"opengl_GL15_nglGenBuffers":"V",
	"opengl_GL15_nglIsBuffer":"Z",
	"opengl_GL15_nglBufferData":"V",
	"opengl_GL15_nglBufferSubData":"V",
	"opengl_GL15_nglGetBufferSubData":"V",
	"opengl_GL15_nglMapBuffer":"L",
	"opengl_GL15_nglUnmapBuffer":"Z",
	"opengl_GL15_nglGetBufferParameteriv":"V",
	"opengl_GL15_nglGetBufferPointerv":"L",
	"opengl_GL15_nglGenQueries":"V",
	"opengl_GL15_nglDeleteQueries":"V",
	"opengl_GL15_nglIsQuery":"Z",
	"opengl_GL15_nglBeginQuery":"V",
	"opengl_GL15_nglEndQuery":"V",
	"opengl_GL15_nglGetQueryiv":"V",
	"opengl_GL15_nglGetQueryObjectiv":"V",
	"opengl_GL15_nglGetQueryObjectuiv":"V",
	"opengl_GL20_nglShaderSource":"V",
	"opengl_GL20_nglShaderSource3":"V",
	"opengl_GL20_nglCreateShader":"I",
	"opengl_GL20_nglIsShader":"Z",
	"opengl_GL20_nglCompileShader":"V",
	"opengl_GL20_nglDeleteShader":"V",
	"opengl_GL20_nglCreateProgram":"I",
	"opengl_GL20_nglIsProgram":"Z",
	"opengl_GL20_nglAttachShader":"V",
	"opengl_GL20_nglDetachShader":"V",
	"opengl_GL20_nglLinkProgram":"V",
	"opengl_GL20_nglUseProgram":"V",
	"opengl_GL20_nglValidateProgram":"V",
	"opengl_GL20_nglDeleteProgram":"V",
	"opengl_GL20_nglUniform1f":"V",
	"opengl_GL20_nglUniform2f":"V",
	"opengl_GL20_nglUniform3f":"V",
	"opengl_GL20_nglUniform4f":"V",
	"opengl_GL20_nglUniform1i":"V",
	"opengl_GL20_nglUniform2i":"V",
	"opengl_GL20_nglUniform3i":"V",
	"opengl_GL20_nglUniform4i":"V",
	"opengl_GL20_nglUniform1fv":"V",
	"opengl_GL20_nglUniform2fv":"V",
	"opengl_GL20_nglUniform3fv":"V",
	"opengl_GL20_nglUniform4fv":"V",
	"opengl_GL20_nglUniform1iv":"V",
	"opengl_GL20_nglUniform2iv":"V",
	"opengl_GL20_nglUniform3iv":"V",
	"opengl_GL20_nglUniform4iv":"V",
	"opengl_GL20_nglUniformMatrix2fv":"V",
	"opengl_GL20_nglUniformMatrix3fv":"V",
	"opengl_GL20_nglUniformMatrix4fv":"V",
	"opengl_GL20_nglGetShaderiv":"V",
	"opengl_GL20_nglGetProgramiv":"V",
	"opengl_GL20_nglGetShaderInfoLog":"V",
	"opengl_GL20_nglGetProgramInfoLog":"V",
	"opengl_GL20_nglGetAttachedShaders":"V",
	"opengl_GL20_nglGetUniformLocation":"I",
	"opengl_GL20_nglGetActiveUniform":"V",
	"opengl_GL20_nglGetUniformfv":"V",
	"opengl_GL20_nglGetUniformiv":"V",
	"opengl_GL20_nglGetShaderSource":"V",
	"opengl_GL20_nglVertexAttrib1s":"V",
	"opengl_GL20_nglVertexAttrib1f":"V",
	"opengl_GL20_nglVertexAttrib1d":"V",
	"opengl_GL20_nglVertexAttrib2s":"V",
	"opengl_GL20_nglVertexAttrib2f":"V",
	"opengl_GL20_nglVertexAttrib2d":"V",
	"opengl_GL20_nglVertexAttrib3s":"V",
	"opengl_GL20_nglVertexAttrib3f":"V",
	"opengl_GL20_nglVertexAttrib3d":"V",
	"opengl_GL20_nglVertexAttrib4s":"V",
	"opengl_GL20_nglVertexAttrib4f":"V",
	"opengl_GL20_nglVertexAttrib4d":"V",
	"opengl_GL20_nglVertexAttrib4Nub":"V",
	"opengl_GL20_nglVertexAttribPointer":"V",
	"opengl_GL20_nglVertexAttribPointerBO":"V",
	"opengl_GL20_nglEnableVertexAttribArray":"V",
	"opengl_GL20_nglDisableVertexAttribArray":"V",
	"opengl_GL20_nglGetVertexAttribfv":"V",
	"opengl_GL20_nglGetVertexAttribdv":"V",
	"opengl_GL20_nglGetVertexAttribiv":"V",
	"opengl_GL20_nglGetVertexAttribPointerv":"L",
	"opengl_GL20_nglBindAttribLocation":"V",
	"opengl_GL20_nglGetActiveAttrib":"V",
	"opengl_GL20_nglGetAttribLocation":"I",
	"opengl_GL20_nglDrawBuffers":"V",
	"opengl_GL20_nglStencilOpSeparate":"V",
	"opengl_GL20_nglStencilFuncSeparate":"V",
	"opengl_GL20_nglStencilMaskSeparate":"V",
	"opengl_GL20_nglBlendEquationSeparate":"V",
	"opengl_GLContext_getFunctionAddress":"J",
	"opengl_GLContext_nUnloadOpenGLLibrary":"V",
	"opengl_GLContext_resetNativeStubs":"V",
	"opengl_LinuxCanvasImplementation_nFindVisualIDFromFormat":"I",
	"opengl_LinuxContextImplementation_nReleaseCurrentContext":"V",
	"opengl_LinuxContextImplementation_nDestroy":"V",
	"opengl_LinuxDisplay_nIsNetWMFullscreenSupported":"Z",
	"opengl_LinuxDisplay_callErrorHandler":"I",
	"opengl_LinuxDisplay_resetErrorHandler":"J",
	"opengl_LinuxDisplay_synchronize":"V",
	"opengl_LinuxDisplay_getErrorText":"L",
	"opengl_LinuxDisplay_closeDisplay":"V",
	"opengl_LinuxDisplay_nUngrabKeyboard":"I",
	"opengl_LinuxDisplay_nGrabKeyboard":"I",
	"opengl_LinuxDisplay_nSetViewPort":"V",
	"opengl_LinuxDisplay_hasProperty":"Z",
	"opengl_LinuxDisplay_getParentWindow":"J",
	"opengl_LinuxDisplay_reparentWindow":"V",
	"opengl_LinuxDisplay_nDestroyWindow":"V",
	"opengl_LinuxDisplay_nSwitchDisplayMode":"V",
	"opengl_LinuxDisplay_nGetGammaRampLength":"I",
	"opengl_LinuxDisplay_nSetGammaRamp":"V",
	"opengl_LinuxDisplay_nConvertToNativeRamp":"L",
	"opengl_LinuxDisplay_nGetCurrentXRandrMode":"L",
	"opengl_LinuxDisplay_setInputFocus":"V",
	"opengl_LinuxDisplay_nReshape":"V",
	"opengl_LinuxDisplay_nGetInputFocus":"J",
	"opengl_LinuxDisplay_sync":"V",
	"opengl_LinuxDisplay_nIconifyWindow":"V",
	"opengl_LinuxDisplay_nGetMinCursorSize":"I",
	"opengl_LinuxDisplay_nGetMaxCursorSize":"I",
	"opengl_LinuxDisplay_nCreateCursor":"J",
	"opengl_LinuxDisplay_nDestroyCursor":"V",
	"opengl_LinuxDisplay_nGetPbufferCapabilities":"I",
	"opengl_LinuxEvent_nGetFocusMode":"I",
	"opengl_LinuxEvent_nGetClientMessageType":"J",
	"opengl_LinuxEvent_nGetClientData":"I",
	"opengl_LinuxEvent_nGetClientFormat":"I",
	"opengl_LinuxEvent_nGetButtonState":"I",
	"opengl_LinuxKeyboard_freeModifierMapping":"V",
	"opengl_LinuxKeyboard_getMaxKeyPerMod":"I",
	"opengl_LinuxKeyboard_lookupModifierMap":"I",
	"opengl_LinuxKeyboard_keycodeToKeySym":"J",
	"opengl_LinuxKeyboard_createIC":"J",
	"opengl_LinuxKeyboard_setupIMEventMask":"V",
	"opengl_LinuxKeyboard_destroyIC":"V",
	"opengl_LinuxKeyboard_closeIM":"V",
	"opengl_LinuxKeyboard_utf8LookupString":"I",
	"opengl_LinuxKeyboard_toUpper":"J",
	"opengl_LinuxPbufferPeerInfo_nInitHandle":"V",
	"opengl_LinuxPbufferPeerInfo_nDestroy":"V",
	"opengl_LinuxPeerInfo_nGetDisplay":"J"
};
for (const [short, r] of Object.entries(__stubTable))
{
	const full = "Java_org_lwjgl_" + short;
	if (__natives[full]) continue;
	let warned = false;
	__natives[full] = function()
	{
		if (!warned) { warned = true; console.warn("[lwjgl stub]", full); }
		return (r === "V") ? undefined : (r === "Z" || r === "I" || r === "J" || r === "F" || r === "D" || r === "B" || r === "S" || r === "C") ? 0 : null;
	};
}

// ===== Diagnostico: registra 1a chamada de cada native, excecoes e quadros por segundo =====
{
	const seen = new Set();
	for (const name of Object.keys(__natives))
	{
		const orig = __natives[name];
		if (typeof orig !== "function") continue;
		__natives[name] = function(...a)
		{
			if (!seen.has(name)) { seen.add(name); console.log("[1a chamada]", name.replace("Java_org_lwjgl_", "")); }
			try
			{
				const r = orig.apply(this, a);
				if (r && typeof r.then === "function")
					return r.catch(e => { console.error("[native erro]", name, e && e.stack ? e.stack : e); throw e; });
				return r;
			}
			catch (e)
			{
				console.error("[native erro]", name, e && e.stack ? e.stack : e);
				throw e;
			}
		};
	}
	let lastFrames = 0;
	setInterval(() => {
		let err = "?";
		try { err = glCtx.getError(); } catch (e) {}
		console.log("[diag] quadros=" + frameCount + " (+" + (frameCount - lastFrames) + ") glErro=" + err + " lost=" + glCtx.isContextLost() + " fb=" + FBW + "x" + FBH + " canvas=" + glCanvas.width + "x" + glCanvas.height);
		lastFrames = frameCount;
	}, 3000);
	glCanvas.addEventListener("webglcontextlost", () => console.error("[diag] WEBGL CONTEXT PERDIDO"));
}

export default __natives;
