package com.mojang.minecraft;

import java.io.IOException;
import java.net.Socket;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SelectableChannel;

/** Substitui SocketChannel no cliente multiplayer: fala com um proxy WebSocket->TCP pelo JavaScript. */
public final class JsChannel {
	/** Modelo da URL do proxy, ex.: ws://localhost:8080/?host={host}&port={port} */
	public static volatile String proxy = "";

	private final ByteBuffer io = ByteBuffer.allocateDirect(65536);
	private int id = -1;
	private boolean closed;

	public static JsChannel open() { return new JsChannel(); }

	public boolean connect(SocketAddress a) throws IOException {
		JsAddr ad = (JsAddr) a;
		if (proxy == null || proxy.length() == 0)
			throw new IOException("Sem proxy WebSocket configurado (tela inicial > Rede / multiplayer)");
		String url = proxy.replace("{host}", ad.host).replace("{port}", String.valueOf(ad.port));
		byte[] b = url.getBytes("UTF-8");
		io.clear();
		io.put(b);
		id = nConnect(io, b.length);
		if (id < 0) throw new IOException("Nao consegui conectar no proxy " + url);
		System.out.println("[net] conectado ao proxy " + url);
		return true;
	}

	public SelectableChannel configureBlocking(boolean b) { return null; }

	public Socket socket() { return null; }

	public int read(ByteBuffer dst) throws IOException {
		if (closed || id < 0) return -1;
		int max = Math.min(dst.remaining(), io.capacity());
		if (max <= 0) return 0;
		int n = nRecv(id, io, max);
		if (n < 0) { closed = true; return -1; }
		if (n > 0) {
			io.clear();
			io.limit(n);
			dst.put(io);
		}
		return n;
	}

	public int write(ByteBuffer src) throws IOException {
		if (closed || id < 0) throw new IOException("conexao fechada");
		int total = 0;
		while (src.hasRemaining()) {
			int n = Math.min(src.remaining(), io.capacity());
			io.clear();
			int lim = src.limit();
			src.limit(src.position() + n);
			io.put(src);
			src.limit(lim);
			if (nSend(id, io, n) < 0) { closed = true; throw new IOException("conexao fechada"); }
			total += n;
		}
		return total;
	}

	public void close() throws IOException {
		if (id >= 0 && !closed) nClose(id);
		closed = true;
	}

	static native int nConnect(ByteBuffer buf, int len);
	static native int nRecv(int id, ByteBuffer buf, int max);
	static native int nSend(int id, ByteBuffer buf, int len);
	static native void nClose(int id);
}
