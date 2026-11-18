terraform {
  required_version = ">= 1.9.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

# Authentication is supplied by the saved connection through OCI_* variables or
# a private OCI_CONFIG_FILE. Never put account identifiers in source or defaults.
provider "oci" {
  region = "us-ashburn-1"
}
