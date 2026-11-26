package com.mojang.minecraft;

import java.net.SocketAddress;

/** Substitui java.net.InetSocketAddress no cliente: guarda host/porta sem resolver DNS (o CheerpJ nao resolve). */
public final class JsAddr extends SocketAddress {
	private static final long serialVersionUID = 1L;
	public final String host;
	public final int port;

	public JsAddr(String host, int port) {
		this.host = host;
		this.port = port;
	}

	public String toString() { return host + ":" + port; }
}
