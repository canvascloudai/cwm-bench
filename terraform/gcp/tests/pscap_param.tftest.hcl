# Offline (mocked provider) checks for the gcp-fit-v1 Cloud SQL flags.
# Run: terraform -chdir=terraform/gcp test

mock_provider "google" {}
mock_provider "random" {}

variables {
  project_id         = "example-project"
  test_id            = "gcp-fit-v1-r1-20261104"
  app_image          = "cwm-bench-pinned-image"
  app_source_git_url = "https://github.com/canvascloudai/cwm-bench.git"
  app_source_git_ref = "881e0cffd51da084be4a24ffd13366dfbb67063f"
}

run "default_is_max_connections_only" {
  command = plan

  assert {
    condition     = google_sql_database_instance.main.database_version == "MYSQL_8_0"
    error_message = "Cloud SQL must be MySQL 8.0"
  }
  assert {
    condition     = google_sql_database_instance.main.region == "us-central1"
    error_message = "default region must be us-central1"
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].tier == "db-custom-2-16384"
    error_message = "default tier must be db-custom-2-16384"
  }
  assert {
    condition     = length(google_sql_database_instance.main.settings[0].database_flags) == 1
    error_message = "default must emit only max_connections"
  }
  assert {
    condition     = one([for flag in google_sql_database_instance.main.settings[0].database_flags : "${flag.name}=${flag.value}"]) == "max_connections=500"
    error_message = "default flag must be max_connections=500"
  }
  assert {
    condition     = output.mysql_max_connections == 500
    error_message = "mysql_max_connections output must be 500"
  }
  assert {
    condition     = output.mysql_max_prepared_stmt_count == 16382
    error_message = "default prepared-statement output must be 16382"
  }
  assert {
    condition     = google_compute_region_instance_group_manager.app.target_size == 2 && google_compute_instance_template.app.machine_type == "n2-standard-2"
    error_message = "app MIG must be 2 x n2-standard-2"
  }
  assert {
    condition     = google_compute_instance.generator.zone == "us-central1-a" && google_compute_instance.generator.machine_type == "c2-standard-4"
    error_message = "generator must be the in-region c2-standard-4"
  }
  assert {
    condition     = google_compute_global_forwarding_rule.http.load_balancing_scheme == "EXTERNAL_MANAGED" && google_compute_global_forwarding_rule.http.port_range == "80"
    error_message = "external HTTP(S) load balancer must listen on port 80"
  }
  assert {
    condition     = length(google_compute_global_forwarding_rule.https) == 0
    error_message = "HTTPS must stay off unless a certificate variable is set"
  }
  assert {
    condition     = output.topology_declaration.cloud == "gcp" && output.topology_declaration.region == "us-central1"
    error_message = "topology must declare cloud=gcp in us-central1"
  }
}

run "pscap_sets_65528" {
  command = plan

  variables {
    test_id                       = "gcp-fit-v1-r1-20261104"
    mysql_max_prepared_stmt_count = 65528
  }

  assert {
    condition     = length(google_sql_database_instance.main.settings[0].database_flags) == 2
    error_message = "pscap must add exactly one flag"
  }
  assert {
    condition     = contains([for flag in google_sql_database_instance.main.settings[0].database_flags : "${flag.name}=${flag.value}"], "max_connections=500")
    error_message = "max_connections must stay 500"
  }
  assert {
    condition     = contains([for flag in google_sql_database_instance.main.settings[0].database_flags : "${flag.name}=${flag.value}"], "max_prepared_stmt_count=65528")
    error_message = "max_prepared_stmt_count=65528 missing"
  }
  assert {
    condition     = output.mysql_max_prepared_stmt_count == 65528
    error_message = "output must be 65528"
  }
}

run "rejects_above_mysql_max" {
  command = plan

  variables {
    mysql_max_prepared_stmt_count = 65529
  }

  expect_failures = [var.mysql_max_prepared_stmt_count]
}
