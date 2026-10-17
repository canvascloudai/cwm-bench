# Offline (mocked provider) checks for the typical-dbsat-pscap-v1 parameter.
# Run: terraform -chdir=terraform test

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-2a", "us-east-2b", "us-east-2c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
}
mock_provider "random" {}

variables {
  test_id            = "typical-dbsat-4x-r1-20261017"
  app_source_git_url = "https://github.com/canvascloudai/cwm-bench.git"
  app_source_git_ref = "881e0cffd51da084be4a24ffd13366dfbb67063f"
}

run "default_is_unchanged" {
  command = plan
  assert {
    condition     = length(aws_db_parameter_group.main.parameter) == 1
    error_message = "default must emit only max_connections (identical to earlier campaigns)"
  }
  assert {
    condition     = one(aws_db_parameter_group.main.parameter).name == "max_connections" && one(aws_db_parameter_group.main.parameter).value == "500"
    error_message = "default parameter group must keep max_connections=500 only"
  }
  assert {
    condition     = output.mysql_max_prepared_stmt_count == 16382
    error_message = "default output must be 16382"
  }
}

run "pscap_sets_65528" {
  command = plan
  variables {
    test_id                       = "typical-dbsat-pscap-4x-r1-20261017"
    mysql_max_prepared_stmt_count = 65528
  }
  assert {
    condition     = length(aws_db_parameter_group.main.parameter) == 2
    error_message = "pscap must add exactly one parameter"
  }
  assert {
    condition     = contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "max_prepared_stmt_count=65528")
    error_message = "max_prepared_stmt_count=65528 missing"
  }
  assert {
    condition     = contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "max_connections=500")
    error_message = "max_connections must stay 500"
  }
}

run "rejects_above_mysql_max" {
  command = plan
  variables {
    mysql_max_prepared_stmt_count = 65529
  }
  expect_failures = [var.mysql_max_prepared_stmt_count]
}
