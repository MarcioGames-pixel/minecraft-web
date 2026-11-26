package com.mojang.minecraft;

import java.nio.ByteBuffer;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.Control;
import javax.sound.sampled.DataLine;
import javax.sound.sampled.Line;
import javax.sound.sampled.LineListener;
import javax.sound.sampled.SourceDataLine;

/** SourceDataLine falso: ritmo de tempo real + envio do PCM para o navegador. */
final class JsLine implements SourceDataLine {
	private final AudioFormat format;
	private boolean open, running, broken;
	private ByteBuffer direct;
	private long nextMs;
	private long framesWritten;
	private int bufFrames = 4410;

	JsLine(AudioFormat f) {
		this.format = f;
	}

	public int write(byte[] b, int off, int len) {
		if (!open) return 0;
		int frameSize = 4;
		boolean silent = true;
		for (int i = off; i < off + len; i += 2) {
			if (b[i] != 0 || b[i + 1] != 0) { silent = false; break; }
		}
		if (!silent && !broken) {
			try {
				if (direct == null || direct.capacity() < len) direct = ByteBuffer.allocateDirect(len);
				direct.clear();
				direct.put(b, off, len);
				direct.flip();
				JsAudio.nPlay(direct, len);
			} catch (Throwable t) {
				broken = true; // sem ponte JS: segue em silencio, sem derrubar o jogo
				t.printStackTrace();
			}
		}
		framesWritten += len / frameSize;
		// imita o bloqueio de uma linha real: devolve quando sobra ~1 buffer de audio
		long chunkMs = (len / frameSize) * 1000L / 44100L;
		long now = System.currentTimeMillis();
		if (nextMs < now) nextMs = now;
		nextMs += chunkMs;
		long wait = nextMs - (bufFrames * 1000L / 44100L) - System.currentTimeMillis();
		if (wait > 0) {
			try { Thread.sleep(wait); } catch (InterruptedException e) { }
		}
		return len;
	}

	public void open(AudioFormat f, int bufferSize) { open = true; bufFrames = Math.max(1, bufferSize / 4); }
	public void open(AudioFormat f) { open = true; }
	public void open() { open = true; }
	public void close() { open = false; running = false; }
	public boolean isOpen() { return open; }
	public void start() { running = true; }
	public void stop() { running = false; }
	public boolean isRunning() { return running; }
	public boolean isActive() { return running; }
	public void drain() { }
	public void flush() { }
	public AudioFormat getFormat() { return format; }
	public int getBufferSize() { return bufFrames * 4; }
	public int available() { return bufFrames * 4; }
	public int getFramePosition() { return (int) framesWritten; }
	public long getLongFramePosition() { return framesWritten; }
	public long getMicrosecondPosition() { return framesWritten * 1000000L / 44100L; }
	public float getLevel() { return -1f; }
	public Line.Info getLineInfo() { return new DataLine.Info(SourceDataLine.class, format); }
	public Control[] getControls() { return new Control[0]; }
	public boolean isControlSupported(Control.Type type) { return false; }
	public Control getControl(Control.Type type) { throw new IllegalArgumentException("sem controles"); }
	public void addLineListener(LineListener l) { }
	public void removeLineListener(LineListener l) { }
}
