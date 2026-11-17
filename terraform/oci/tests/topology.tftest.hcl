mock_provider "oci" {
  mock_data "oci_identity_compartment" {
    defaults = {
      name = "cwm-bench-oci"
    }
  }
}
mock_provider "random" {}

variables {
  compartment_id      = "runtime-compartment"
  tenancy_id          = "runtime-tenancy"
  availability_domain = "runtime:US-ASHBURN-AD-1"
  image_id            = "runtime-image"
  ssh_public_key      = "runtime-public-key"
  controller_cidr     = "192.0.2.1/32"
  budget_recipients   = "runner@example.invalid"
  test_id             = "oci-holdout-v1-r1-ad1-20261120"
  measurement_sha     = "1111111111111111111111111111111111111111"
}
run "frozen_topology" {
  command = plan
  assert {
    condition     = length(oci_core_instance.app) == 2 && oci_core_instance.generator.shape_config[0].ocpus == 2 && oci_core_instance.app[0].shape_config[0].memory_in_gbs == 16
    error_message = "Require two apps and the same-sized generator."
  }
  assert {
    condition     = oci_core_instance.app[0].availability_domain == oci_core_instance.generator.availability_domain && oci_mysql_mysql_db_system.main.availability_domain == var.availability_domain
    error_message = "All tiers must share the recorded AD."
  }
  assert {
    condition     = oci_mysql_mysql_db_system.main.shape_name == "MySQL.2" && oci_mysql_mysql_db_system.main.is_highly_available == false && oci_mysql_mysql_db_system.main.data_storage_size_in_gb == 100 && oci_mysql_mysql_configuration.main.variables[0].max_connections == 1000
    error_message = "No DB product/size/configuration substitution."
  }
  assert {
    condition     = oci_mysql_mysql_db_system.main.backup_policy[0].is_enabled == false && oci_mysql_mysql_db_system.main.deletion_policy[0].is_delete_protected == false && oci_mysql_mysql_db_system.main.deletion_policy[0].final_backup == "SKIP_FINAL_BACKUP"
    error_message = "No backup/delete-protection costs."
  }
  assert {
    condition     = oci_load_balancer_load_balancer.main.shape_details[0].minimum_bandwidth_in_mbps == 10 && oci_load_balancer_load_balancer.main.shape_details[0].maximum_bandwidth_in_mbps == 100 && oci_load_balancer_listener.http.port == 80
    error_message = "Frozen public Flexible LB configuration."
  }
  assert {
    condition     = oci_budget_alert_rule.actual["15"].threshold == 15 && oci_budget_alert_rule.actual["25"].threshold == 25 && oci_budget_alert_rule.actual["25"].type == "ACTUAL" && oci_budget_alert_rule.actual["25"].threshold_type == "ABSOLUTE"
    error_message = "Budget rules must be alert-only actual USD thresholds."
  }
  assert {
    condition     = random_password.db.length == 32 && random_password.db.special == true && random_password.db.min_special == 1 && random_password.db.min_upper == 1 && random_password.db.min_lower == 1 && random_password.db.min_numeric == 1 && random_password.db.override_special == "!#%*()-_=+[]{}:?"
    error_message = "OCI MySQL admin password must meet HeatWave 8-32 / complexity rules with a shell-safe override_special."
  }
}
run "wrong_compartment" {
  command = plan
  override_data {
    target = data.oci_identity_compartment.target
    values = { name = "unrelated" }
  }
  expect_failures = [oci_core_vcn.main]
}
run "wrong_ad" {
  command = plan
  variables {
    availability_domain = "runtime:US-ASHBURN-AD-2"
  }
  expect_failures = [oci_core_vcn.main]
}
