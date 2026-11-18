# Per-instance keys belong to this apply's private Terraform state. Never export
# private keys, user_data, plan JSON or state as campaign evidence.
resource "tls_private_key" "app_host" {
  count     = 2
  algorithm = "ED25519"
}

resource "tls_private_key" "generator_host" {
  algorithm = "ED25519"
}
