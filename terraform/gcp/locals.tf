locals {
  id_slug = lower(replace(var.test_id, "_", "-"))
  name    = var.name_prefix

  public_cidr  = cidrsubnet(var.vpc_cidr, 8, 0)
  private_cidr = cidrsubnet(var.vpc_cidr, 8, 10)

  # Account ids are 6-30 chars and must differ per apply. Hyphens are stripped
  # so a short slug still meets the minimum length.
  sa_app = substr("app${replace(local.id_slug, "-", "")}bench", 0, 30)
  sa_gen = substr("gen${replace(local.id_slug, "-", "")}bench", 0, 30)

  # Google health-check and LB proxy ranges, plus IAP for SSH. Not project ids.
  health_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
  iap_range     = "35.235.240.0/20"
}
