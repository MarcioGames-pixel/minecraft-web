package com.mojang.minecraft;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.LineUnavailableException;
import javax.sound.sampled.SourceDataLine;

/** Substitui javax.sound.sampled.AudioSystem (nao existe no CheerpJ): entrega o PCM ao WebAudio via JS. */
public final class JsAudio {
	private JsAudio() {}

	public static SourceDataLine getSourceDataLine(AudioFormat format) throws LineUnavailableException {
		if (!MCApplet.audioOn) throw new LineUnavailableException("som desligado");
		return new JsLine(format);
	}

	/** Implementado em JavaScript (lwjgl.js): toca PCM 16-bit estereo big-endian 44100 Hz. */
	static native void nPlay(java.nio.ByteBuffer buf, int len);
}
