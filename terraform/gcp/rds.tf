resource "random_password" "db" {
  length  = 24
  special = false
}

resource "google_secret_manager_secret" "db_password" {
  secret_id = "${local.name}-${local.id_slug}-db-password"

  replication {
    auto {}
  }

  labels = {
    project    = "cwm-bench"
    test_id    = local.id_slug
    managed_by = "terraform"
  }
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

# Destroy: instance first (timeouts.delete 60m), then the private-services
# connection, then the network. Do not detach Cloud SQL's allocated range
# by hand.
resource "google_sql_database_instance" "main" {
  name             = "${local.name}-${local.id_slug}"
  database_version = "MYSQL_8_0"
  region           = var.region

  deletion_protection = false

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = var.db_disk_gb
    disk_type         = "PD_SSD"
    disk_autoresize   = false

    deletion_protection_enabled = false

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
    }

    backup_configuration {
      enabled = false
    }

    database_flags {
      name  = "max_connections"
      value = tostring(var.mysql_max_connections)
    }

    # At the engine default (16382) the flag is omitted, matching the AWS
    # parameter-group behaviour the pscap test locks.
    dynamic "database_flags" {
      for_each = var.mysql_max_prepared_stmt_count == 16382 ? [] : [tostring(var.mysql_max_prepared_stmt_count)]
      content {
        name  = "max_prepared_stmt_count"
        value = database_flags.value
      }
    }

    user_labels = {
      project    = "cwm-bench"
      test_id    = local.id_slug
      managed_by = "terraform"
      role       = "database"
    }
  }

  timeouts {
    create = "40m"
    update = "80m"
    delete = "60m"
  }

  depends_on = [google_service_networking_connection.private]
}

resource "google_sql_database" "main" {
  name     = "cwmbench"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "main" {
  name     = var.db_username
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
  host     = "%"
}
