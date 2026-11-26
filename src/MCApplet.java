package com.mojang.minecraft;

import com.mojang.minecraft.level.Level;
import com.mojang.minecraft.player.Player;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Random;
import javax.imageio.ImageIO;

/**
 * Applet de entrada para a versao web:
 *  - skin do jogador (parametro "skin" = data URL PNG)
 *  - salvar o mundo automaticamente em /files/level.dat (persistente no navegador)
 *  - sons sintetizados (passos e blocos), ja que o jogo nao traz arquivos de audio
 */
public class MCApplet extends MinecraftApplet {
	private static final long serialVersionUID = 1L;
	static final String LEVEL = "/files/level.dat";
	private static boolean started;

	public void init() {
		try {
			if ("1".equals(getParameter("fresh"))) {
				new File(LEVEL).delete();
				new File(LEVEL + ".tmp").delete();
				System.out.println("[mc] mundo salvo apagado (mundo novo)");
			}
		} catch (Throwable t) {
			t.printStackTrace();
		}
		super.init();
	}

	public void start() {
		super.start();
		synchronized (MCApplet.class) {
			if (started) return;
			started = true;
		}
		installSkin();
		final l mc = getMc();
		if (mc == null) {
			System.out.println("[mc] nao achei a instancia do jogo; salvar/sons desativados");
			return;
		}
		final boolean multiplayer = (getParameter("server") != null && getParameter("server").length() > 0) || !"1".equals(getParameter("autosave"));
		if (multiplayer) System.out.println("[mc] autosave do mundo local desativado");
		Thread t = new Thread(new Runnable() {
			public void run() { helperLoop(mc, multiplayer); }
		}, "mc-helpers");
		t.setDaemon(true);
		t.start();
	}

	private l getMc() {
		try {
			Field f = MinecraftApplet.class.getDeclaredField("minecraft");
			f.setAccessible(true);
			return (l) f.get(this);
		} catch (Throwable t) {
			t.printStackTrace();
			return null;
		}
	}

	private void installSkin() {
		try {
			String s = getParameter("skin");
			if (s == null || s.length() < 32) return;
			int comma = s.indexOf(',');
			if (comma >= 0) s = s.substring(comma + 1);
			byte[] png = java.util.Base64.getDecoder().decode(s.trim());
			Player.newTexture = ImageIO.read(new ByteArrayInputStream(png));
			System.out.println("[mc] skin carregada");
		} catch (Throwable t) {
			System.out.println("[mc] skin invalida: " + t);
		}
	}

	@SuppressWarnings({ "rawtypes", "unchecked" })
	private void helperLoop(l mc, boolean multiplayer) {
		boolean soundDone = false;
		long lastSave = System.currentTimeMillis();
		int lastHash = 0;
		while (true) {
			try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
			try {
				if (!soundDone && mc.s != null) {
					registerSounds(mc.s.a);
					soundDone = true;
					System.out.println("[mc] sons registrados");
				}
				long now = System.currentTimeMillis();
				if (!multiplayer && now - lastSave >= 120000) {
					lastSave = now;
					Level lv = mc.d;
					if (lv != null && lv.blocks != null) {
						int h = Arrays.hashCode(lv.blocks);
						if (h != lastHash) {
							if (saveLevel(lv)) lastHash = h;
						}
					}
				}
			} catch (Throwable t) {
				t.printStackTrace();
			}
		}
	}

	private static boolean saveLevel(Level lv) {
		File tmp = new File(LEVEL + ".tmp");
		File dst = new File(LEVEL);
		try {
			// serializa na memoria e grava de uma vez: o GZIP escrevendo direto no arquivo gerava milhares de escritas
			// pequenas no armazenamento do CheerpJ, o que travava o jogo
			java.io.ByteArrayOutputStream mem = new java.io.ByteArrayOutputStream(1 << 20);
			com.mojang.minecraft.level.a.a(lv, mem);
			byte[] data = mem.toByteArray();
			OutputStream out = new FileOutputStream(tmp);
			try {
				out.write(data, 0, data.length);
			} finally {
				try { out.close(); } catch (Throwable ignored) { }
			}
			if (tmp.length() < 16) { tmp.delete(); return false; }
			if (dst.exists()) dst.delete();
			if (!tmp.renameTo(dst)) {
				copy(tmp, dst);
				tmp.delete();
			}
			System.out.println("[mc] mundo salvo (" + dst.length() + " bytes)");
			return true;
		} catch (Throwable t) {
			System.out.println("[mc] falha ao salvar: " + t);
			return false;
		}
	}

	private static void copy(File a, File b) throws java.io.IOException {
		InputStream in = new FileInputStream(a);
		OutputStream out = new FileOutputStream(b);
		try {
			byte[] buf = new byte[16384];
			int n;
			while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
		} finally {
			in.close();
			out.close();
		}
	}

	// ------------------------------------------------------------ sons

	@SuppressWarnings({ "rawtypes", "unchecked" })
	private static void registerSounds(Map map) {
		String[] names = { "grass", "gravel", "stone", "wood", "cloth", "metal" };
		java.lang.reflect.Constructor ctor;
		try {
			// o pacote com.mojang.minecraft.c colide com a classe c: usa reflexao
			ctor = Class.forName("com.mojang.minecraft.c.b").getConstructor(short[].class, float.class);
		} catch (Throwable t) {
			System.out.println("[mc] classe de som nao encontrada: " + t);
			return;
		}
		synchronized (map) {
			for (int k = 0; k < names.length; k++) {
				String key = "step." + names[k];
				List list = (List) map.get(key);
				if (list == null) {
					list = new ArrayList();
					map.put(key, list);
				}
				// sons originais (convertidos para PCM e guardados no jar); se faltar, usa o sintetizado
				List<short[]> pcms = new ArrayList<short[]>();
				for (int v = 1; v <= 8; v++) {
					short[] pcm = loadRaw("/mcsnd/" + key + "." + v + ".raw");
					if (pcm == null) break;
					pcms.add(pcm);
				}
				if (pcms.isEmpty()) {
					for (int v = 0; v < 3; v++) pcms.add(synth(k, 1000L * k + v));
				}
				for (short[] pcm : pcms) {
					try {
						list.add(ctor.newInstance(pcm, Float.valueOf(44100f)));
					} catch (Throwable t) {
						System.out.println("[mc] erro ao criar som: " + t);
						return;
					}
				}
			}
		}
	}

	/** PCM 16-bit mono 44100 Hz big-endian guardado como recurso do jar */
	private static short[] loadRaw(String res) {
		try {
			InputStream in = MCApplet.class.getResourceAsStream(res);
			if (in == null) return null;
			java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
			byte[] buf = new byte[8192];
			int n;
			while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
			in.close();
			byte[] b = bo.toByteArray();
			short[] out = new short[b.length / 2];
			for (int i = 0; i < out.length; i++) out[i] = (short) (((b[2 * i] & 0xff) << 8) | (b[2 * i + 1] & 0xff));
			return out;
		} catch (Throwable t) {
			System.out.println("[mc] recurso de som falhou " + res + ": " + t);
			return null;
		}
	}

	/** kind: 0 grama, 1 cascalho, 2 pedra, 3 madeira, 4 pano, 5 metal */
	static short[] synth(int kind, long seed) {
		final double rate = 44100.0;
		double ms, decay, lp, noiseAmp, f1, f2, toneAmp;
		switch (kind) {
			case 0:  ms = 130; decay = 26; lp = 0.20; noiseAmp = 1.0; f1 = 0;   f2 = 0;    toneAmp = 0;   break;
			case 1:  ms = 150; decay = 20; lp = 0.55; noiseAmp = 0.9; f1 = 0;   f2 = 0;    toneAmp = 0;   break;
			case 2:  ms = 110; decay = 38; lp = 0.75; noiseAmp = 0.6; f1 = 170; f2 = 310;  toneAmp = 0.5; break;
			case 3:  ms = 140; decay = 30; lp = 0.15; noiseAmp = 0.3; f1 = 130; f2 = 210;  toneAmp = 0.9; break;
			case 4:  ms = 170; decay = 18; lp = 0.08; noiseAmp = 0.8; f1 = 0;   f2 = 0;    toneAmp = 0;   break;
			default: ms = 320; decay = 10; lp = 0.85; noiseAmp = 0.15; f1 = 780; f2 = 1190; toneAmp = 0.7; break;
		}
		int n = (int) (rate * ms / 1000.0);
		Random r = new Random(seed * 7919L + 13);
		double detune = 0.92 + r.nextDouble() * 0.16;
		double[] out = new double[n];
		double y = 0, peak = 1e-9;
		for (int i = 0; i < n; i++) {
			double t = i / rate;
			double env = Math.exp(-t * decay) * Math.min(1.0, i / 60.0);
			double noise = r.nextDouble() * 2 - 1;
			y += lp * (noise - y);
			double s = y * noiseAmp * 2.2;
			if (f1 > 0) s += toneAmp * (Math.sin(2 * Math.PI * f1 * detune * t) * 0.7 + Math.sin(2 * Math.PI * f2 * detune * t) * 0.3);
			s *= env;
			out[i] = s;
			if (Math.abs(s) > peak) peak = Math.abs(s);
		}
		short[] pcm = new short[n];
		double g = 0.5 * 32767.0 / peak;
		for (int i = 0; i < n; i++) pcm[i] = (short) Math.max(-32768, Math.min(32767, out[i] * g));
		return pcm;
	}
}
