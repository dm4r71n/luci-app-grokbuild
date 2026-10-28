include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Grok Build terminal
LUCI_DEPENDS:=+luci-base +ttyd +tmux +openssl-util
LUCI_PKGARCH:=all

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
