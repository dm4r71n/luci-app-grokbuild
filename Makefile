include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Grok Build terminal behind the LuCI login
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ttyd +tmux +stunnel +openssl-util \
	+ucode +ucode-mod-fs +ucode-mod-socket +ucode-mod-uloop +ucode-mod-ubus +ucode-mod-uci
LUCI_PKGARCH:=all

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
