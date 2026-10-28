include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Grok Build terminal
LUCI_DEPENDS:=+luci-base +ttyd +tmux
LUCI_PKGARCH:=all

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
