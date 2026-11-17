resource "random_password" "db" {
  length  = 32
  special = false
}
resource "oci_mysql_mysql_configuration" "main" {
  compartment_id = var.compartment_id
  shape_name     = "MySQL.2"
  display_name   = var.test_id
  freeform_tags  = local.tags
  variables {
    max_connections = 1000
  }
}
resource "oci_mysql_mysql_db_system" "main" {
  compartment_id          = var.compartment_id
  availability_domain     = var.availability_domain
  subnet_id               = oci_core_subnet.db.id
  shape_name              = "MySQL.2"
  configuration_id        = oci_mysql_mysql_configuration.main.id
  admin_username          = "cwmbench"
  admin_password          = random_password.db.result
  data_storage_size_in_gb = 100
  is_highly_available     = false
  display_name            = var.test_id
  freeform_tags           = local.tags
  backup_policy {
    is_enabled = false
    pitr_policy {
      is_enabled = false
    }
  }
  data_storage {
    is_auto_expand_storage_enabled = false
  }
  deletion_policy {
    automatic_backup_retention = "DELETE"
    final_backup               = "SKIP_FINAL_BACKUP"
    is_delete_protected        = false
  }
  lifecycle {
    # CreateDbSystem has no writable heatWave=false field. A HeatWave cluster
    # requires a separate AddHeatWaveCluster call/resource, intentionally absent.
    # Fail closed on the API's attachment flag; readiness re-reads it before load.
    postcondition {
      condition     = self.is_heat_wave_cluster_attached == false
      error_message = "HeatWave must be explicitly excluded from this stack."
    }
    postcondition {
      condition     = startswith(self.mysql_version, "8.")
      error_message = "MySQL must remain 8.x; never substitute a database product."
    }
  }
}
