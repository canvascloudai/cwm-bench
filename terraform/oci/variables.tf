variable "compartment_id" {
  type      = string
  sensitive = true
}
variable "tenancy_id" {
  type      = string
  sensitive = true
}
variable "availability_domain" {
  type      = string
  sensitive = true
}
variable "image_id" {
  type      = string
  sensitive = true
}
variable "ssh_public_key" {
  type      = string
  sensitive = true
}
variable "controller_cidr" {
  type = string
  validation {
    condition     = can(cidrhost(var.controller_cidr, 0)) && endswith(var.controller_cidr, "/32")
    error_message = "SSH requires the controller's single IPv4 /32."
  }
}
variable "budget_recipients" {
  type      = string
  sensitive = true
}
variable "test_id" {
  type = string
  validation {
    condition     = can(regex("^oci-holdout-v1-r[12]-ad[123][a-c]?-[0-9]{8}$", var.test_id))
    error_message = "Use the frozen OCI apply-id format."
  }
}
variable "measurement_sha" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.measurement_sha))
    error_message = "Supply the exact merged measurement commit, never a branch."
  }
}

data "oci_identity_compartment" "target" {
  id = var.compartment_id
}

locals {
  tags = { test_id = var.test_id, campaign = "oci-holdout-v1" }
}
