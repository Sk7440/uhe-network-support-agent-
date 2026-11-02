# UHE Lahore — IP Subnet Ranges

> TEMPLATE: replace every `<...>` with the real values from UHE IT before uploading. Delete rows you don't need.
> Do NOT include passwords or device admin details.

## Summary

- DHCP is used on all user networks. Users should never set a static IP.
- An address starting with **169.254.x.x** means the device did not receive an IP from DHCP.
- Any address outside the ranges below on campus means the user is on the wrong network or a rogue DHCP server is present — escalate.

## Ranges by area

| Area / Building | Network type | Subnet (CIDR) | Usable range | Default Gateway | DNS servers |
|---|---|---|---|---|---|
| <Admin Block> | LAN | <10.x.x.0/24> | <10.x.x.10 – 10.x.x.250> | <10.x.x.1> | <...> |
| <Academic Block> | LAN | <...> | <...> | <...> | <...> |
| <Library> | LAN | <...> | <...> | <...> | <...> |
| <Computer Labs> | LAN | <...> | <...> | <...> | <...> |
| <Campus Wi-Fi – Staff> | Wi-Fi | <...> | <...> | <...> | <...> |
| <Campus Wi-Fi – Students> | Wi-Fi | <...> | <...> | <...> | <...> |
| <Hostels> | Wi-Fi | <...> | <...> | <...> | <...> |

## Known reserved / excluded addresses

- <e.g. .1 – .9 reserved for network devices>
- <e.g. .251 – .254 reserved for servers / printers>
